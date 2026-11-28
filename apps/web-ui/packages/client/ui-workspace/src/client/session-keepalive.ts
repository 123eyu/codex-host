/** Browser-root data retention, independent of mounted Session views. */
import type {
  ISessions,
  SessionBinding,
  SessionListState,
  SessionReference,
  SessionTarget,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { IWorkspaces } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap {
    /** Live data only; does not mark a Session as viewed. */
    backgroundWarm: unknown;
  }
}

/** Maximum stopped warm sessions kept retained in the background. */
export const MAX_STOPPED_WARM_SESSIONS = 4;

/** Maximum estimated effective byte budget across stopped warm sessions (32 MiB). */
export const MAX_STOPPED_WARM_BYTES = 32 * 1024 * 1024;

/** Maximum non-viewed background running sessions kept retained warm. */
export const MAX_BACKGROUND_RUNNING_SESSIONS = 2;

/** Maximum estimated effective byte budget across all warm sessions (48 MiB). */
export const MAX_TOTAL_WARM_BYTES = 48 * 1024 * 1024;

/**
 * Multiplier applied to raw `Session.estimatedBytes()` to account for downstream
 * `UiConversation` assembly overhead (contexts, view builders, slices, groups).
 */
export const WARM_SESSION_ASSEMBLY_OVERHEAD_FACTOR = 3;

export interface SessionKeepaliveOptions {
  readonly maxStoppedSessions?: number;
  readonly maxStoppedBytes?: number;
  readonly maxBackgroundRunningSessions?: number;
  readonly maxTotalBytes?: number;
  readonly assemblyOverheadFactor?: number;
}

interface HeldSession {
  readonly reference: SessionReference;
  readonly binding: SessionBinding;
}

/** Bounded background warm retention for recently visited Sessions. */
export class SessionKeepalive {
  private readonly held = new Map<SessionId, HeldSession>();
  private readonly recent = new Map<SessionId, SessionTarget>();
  private running = new Set<SessionId>();
  /** Invalid bindings and rejected acquisitions stay suppressed until leaving the targets or a visit. */
  private readonly failed = new Set<SessionId>();
  private readonly maxStoppedSessions: number;
  private readonly maxStoppedBytes: number;
  private readonly maxBackgroundRunningSessions: number;
  private readonly maxTotalBytes: number;
  private readonly assemblyOverheadFactor: number;
  private lastVisited: SessionId | undefined;
  private active = false;
  private reconciling = false;
  private dirty = false;

  constructor(
    private readonly sessions: ISessions,
    private readonly workspaces: IWorkspaces,
    options: SessionKeepaliveOptions = {},
  ) {
    this.maxStoppedSessions = Math.max(0, options.maxStoppedSessions ?? MAX_STOPPED_WARM_SESSIONS);
    this.maxStoppedBytes = Math.max(0, options.maxStoppedBytes ?? MAX_STOPPED_WARM_BYTES);
    this.maxBackgroundRunningSessions = Math.max(
      0,
      options.maxBackgroundRunningSessions ?? MAX_BACKGROUND_RUNNING_SESSIONS,
    );
    this.maxTotalBytes =
      options.maxTotalBytes === undefined
        ? Math.max(this.maxStoppedBytes, MAX_TOTAL_WARM_BYTES)
        : Math.max(0, options.maxTotalBytes);
    this.assemblyOverheadFactor = Math.max(
      1,
      options.assemblyOverheadFactor ?? WARM_SESSION_ASSEMBLY_OVERHEAD_FACTOR,
    );
  }

  start(): () => void {
    this.active = true;
    const stopSessions = this.sessions.list.subscribe(() => this.reconcile());
    const stopWorkspaces = this.workspaces.list.subscribe(() => this.reconcile());
    this.reconcile();
    return () => {
      this.active = false;
      stopSessions();
      stopWorkspaces();
      const held = [...this.held.values()];
      this.held.clear();
      this.recent.clear();
      this.running.clear();
      this.failed.clear();
      this.lastVisited = undefined;
      for (const { reference } of held) reference.release();
    };
  }

  /** Called only after accepted navigation, before releasing the previous main-view reference. */
  visit(reference: SessionReference, target: SessionTarget): void {
    if (!this.active) return;
    this.lastVisited = reference.sessionId;
    this.failed.delete(reference.sessionId);
    this.remember(
      reference.sessionId,
      typeof target === "string"
        ? (this.sessions.subagentAddress(reference.sessionId) ?? target)
        : target,
    );
    this.reconcile();
  }

  private remember(id: SessionId, target: SessionTarget): void {
    this.recent.delete(id);
    this.recent.set(id, target);
  }

  /**
   * Sessions held by any active view (e.g. `mainView`, `sidebarView`) are never
   * evicted by warm-session budgets. When a minimal `ISessions` double does not
   * track reference sources at all, fall back to protecting the latest `visit`.
   */
  private isProtectedView(id: SessionId, list: SessionListState): boolean {
    let hasTrackedSource = false;
    for (const retainedBy of [
      this.sessions.retainInfo?.(id)?.getSnapshot().retainedBy,
      list.byId[id]?.retainedBy,
    ]) {
      if (retainedBy === undefined) continue;
      for (const [source, count] of Object.entries(retainedBy)) {
        if ((count ?? 0) <= 0) continue;
        hasTrackedSource = true;
        if (source !== "backgroundWarm") return true;
      }
    }
    if (hasTrackedSource) return false;
    return id === this.lastVisited;
  }

  private reconcile(): void {
    if (!this.active) return;
    // retain/release publish list changes synchronously, before retain returns its handle.
    this.dirty = true;
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      while (this.dirty && this.active) {
        this.dirty = false;
        this.update();
      }
    } finally {
      this.reconciling = false;
    }
  }

  private update(): void {
    const list = this.sessions.list.getSnapshot();
    const catalog = new Set(list.ids);
    const archived = new Set(this.workspaces.list.getSnapshot().archivedSessionIds);

    for (const [id, target] of this.recent) {
      if (
        archived.has(id) ||
        this.sessions.binding(id)?.session.getSnapshot().removed ||
        (list.phase === "ready" && !catalog.has(id) && typeof target === "string")
      ) {
        this.recent.delete(id);
        this.running.delete(id);
        if (this.lastVisited === id) this.lastVisited = undefined;
      }
    }

    // Only recently visited Sessions enter warm retention; sidebar indicators, completion
    // badges, desktop notifications, and pending interactions do not need full transcripts.
    const running = new Set<SessionId>();
    for (const id of this.recent.keys()) {
      const row = list.byId[id];
      if (row?.running && row.origin !== "subagent") {
        running.add(id);
      } else if (list.phase === "pending" && this.running.has(id)) {
        running.add(id);
      }
    }
    this.running = running;

    const protectedIds = new Set<SessionId>();
    const effectiveBytesById = new Map<SessionId, number>();
    let totalBytes = 0;
    for (const id of this.recent.keys()) {
      if (this.isProtectedView(id, list)) protectedIds.add(id);
      const rawBytes = Math.max(0, this.sessions.estimatedBytes?.(id) ?? 0);
      const effectiveBytes = rawBytes * this.assemblyOverheadFactor;
      effectiveBytesById.set(id, effectiveBytes);
      totalBytes += effectiveBytes;
    }

    const stopped = [...this.recent.keys()].filter((id) => !running.has(id));
    let stoppedCount = stopped.length;
    let stoppedBytes = 0;
    for (const id of stopped) stoppedBytes += effectiveBytesById.get(id) ?? 0;

    for (const id of stopped) {
      if (stoppedCount <= this.maxStoppedSessions && stoppedBytes <= this.maxStoppedBytes) break;
      if (protectedIds.has(id)) continue;
      const bytes = effectiveBytesById.get(id) ?? 0;
      this.recent.delete(id);
      stoppedCount -= 1;
      stoppedBytes -= bytes;
      totalBytes -= bytes;
    }

    const backgroundRunning = [...this.recent.keys()].filter(
      (id) => running.has(id) && !protectedIds.has(id),
    );
    let backgroundRunningCount = backgroundRunning.length;
    for (const id of backgroundRunning) {
      if (backgroundRunningCount <= this.maxBackgroundRunningSessions) break;
      const bytes = effectiveBytesById.get(id) ?? 0;
      this.recent.delete(id);
      running.delete(id);
      backgroundRunningCount -= 1;
      totalBytes -= bytes;
    }

    if (totalBytes > this.maxTotalBytes) {
      const remainingStopped = [...this.recent.keys()].filter(
        (id) => !running.has(id) && !protectedIds.has(id),
      );
      for (const id of remainingStopped) {
        if (totalBytes <= this.maxTotalBytes) break;
        this.recent.delete(id);
        totalBytes -= effectiveBytesById.get(id) ?? 0;
      }
    }
    if (totalBytes > this.maxTotalBytes) {
      const remainingBackgroundRunning = [...this.recent.keys()].filter(
        (id) => running.has(id) && !protectedIds.has(id),
      );
      for (const id of remainingBackgroundRunning) {
        if (totalBytes <= this.maxTotalBytes) break;
        this.recent.delete(id);
        running.delete(id);
        totalBytes -= effectiveBytesById.get(id) ?? 0;
      }
    }

    const targets = new Map(this.recent);
    for (const id of this.failed) if (!targets.has(id)) this.failed.delete(id);

    for (const [id, held] of this.held) {
      const invalid = this.sessions.binding(id) !== held.binding;
      if (!targets.has(id) || invalid) {
        this.held.delete(id);
        if (invalid) {
          this.recent.delete(id);
          this.failed.add(id);
        }
        held.reference.release();
      }
    }
    for (const [id, target] of targets) {
      if (this.held.has(id) || this.failed.has(id)) continue;
      let reference: SessionReference | undefined;
      try {
        reference = this.sessions.retain(target, { source: "backgroundWarm" });
        const held = { reference, binding: reference.binding };
        this.held.set(id, held);
        // Session.open records sync failures in its snapshot. Keep that valid generation
        // for the Controller's reconnect resync; release rejected acquisition waiters only.
        // Reconcile once initial opening settles so freshly loaded history bytes are accounted for.
        void reference.ready.then(
          () => {
            if (this.active && this.held.get(id) === held) this.reconcile();
          },
          () => this.fail(id, held),
        );
      } catch {
        this.failed.add(id);
        reference?.release();
      }
    }
  }

  private fail(id: SessionId, held: HeldSession): void {
    if (!this.active || this.held.get(id) !== held) return;
    this.failed.add(id);
    this.held.delete(id);
    held.reference.release();
  }
}
