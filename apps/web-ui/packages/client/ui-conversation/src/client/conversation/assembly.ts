/** Per-Session target-neutral Conversation assembly. */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type {
  ISessions,
  SessionBinding,
  SessionEventSource,
  SessionEventWindow,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session/types";
import { WeakMapWithValues } from "@deepseek-ai/dsh-util-values";
import {
  createSnapshotStore,
  type ObservableSnapshot,
  type SnapshotStore,
} from "@deepseek-ai/dsh-client-store";
import type {
  ConversationPublication,
  ConversationViewSnapshotMap,
  ConversationViewSnapshotStore,
} from "../contract/conversation.ts";
import type { ConversationSnapshot } from "../contract/snapshot.ts";
import type {
  ConversationPromptSnapshot,
  RequestPromptInspection,
  SystemPromptNode,
} from "../contract/request-inspection.ts";
import { inspectRequestPrompt } from "../contract/request-inspection.ts";
import { inspectSystemPrompt, type SystemPromptState } from "../contract/system-prompt.ts";
import { ConversationNodeAssembler } from "./assembler.ts";
import { ConversationEventRegistry } from "./event-registry.ts";
import { HistoricalImageCache, type UploadedImageCacheEntry } from "./historical-images.ts";
import { ConversationViewRegistry } from "./view-registry.ts";
import { ConversationGroupRegistry } from "./group-registry.ts";

/** Coalescing window for high-frequency live-chunk UI notifications when visible. */
export const LIVE_STREAM_COALESCE_MS = 40;

const SHELL_WINDOW_HIDDEN_EVENT = "codexhost:window-hidden-change";

function isShellWindowHidden(event?: Event): boolean {
  const detail = (event as { detail?: { hidden?: unknown } } | undefined)?.detail;
  if (typeof detail?.hidden === "boolean") return detail.hidden;
  const winHidden =
    typeof window !== "undefined"
      ? (window as { __codexhostWindowHidden?: unknown }).__codexhostWindowHidden
      : undefined;
  if (typeof winHidden === "boolean") return winHidden;
  const globalHidden = (globalThis as { __codexhostWindowHidden?: unknown })
    .__codexhostWindowHidden;
  return globalHidden === true;
}

function isWindowHidden(event?: Event): boolean {
  const docHidden = typeof document !== "undefined" && document.hidden === true;
  return docHidden || isShellWindowHidden(event);
}

/** Observable faces published for one Session's Conversation assembly. */
export interface ConversationBinding {
  readonly snapshot: ObservableSnapshot<ConversationSnapshot>;
  /**
   * Identity-stable source of the latest turn number, undefined unless its start is loaded and it remains open.
   * Turn changes publish synchronously, including without an active View.
   */
  readonly openTurn: ObservableSnapshot<number | undefined>;
  /**
   * Add one selected target to the Session's monotonic active set.
   * @param target - registered or subsequently registered Conversation target.
   */
  activate(target: string): void;
  /**
   * Resolve one target-owned snapshot source.
   * The first subscriber activates the target unless shell selection already
   * activated it; activation lasts for the remaining Session lifetime.
   * @param target - registered Conversation target.
   * @returns identity-stable source following the target.
   */
  target<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined>;
}

class BoundConversation implements ConversationBinding {
  readonly snapshot: SnapshotStore<ConversationSnapshot>;
  readonly openTurn: SnapshotStore<number | undefined>;
  private readonly viewStore: ConversationViewSnapshotStore;
  private readonly targetSources = new Map<string, ObservableSnapshot<unknown>>();
  private revision = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private deferredWhileHidden = false;
  private disposed = false;
  private disposeVisibilityListeners: (() => void) | undefined;
  private disposeFeed: () => void = () => {};

  constructor(
    feed: SessionEventSource,
    private readonly assembler: ConversationNodeAssembler,
  ) {
    this.viewStore = assembler;
    this.snapshot = createSnapshotStore(this.currentSnapshot());
    this.openTurn = createSnapshotStore(assembler.openTurn());
    this.replace(feed.getSnapshot());
    this.disposeFeed = feed.subscribe(() => {
      this.accept(feed.getSnapshot());
    });
  }

  target<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined> {
    let source = this.targetSources.get(target);
    if (source === undefined) {
      const views = this.viewStore as { get(key: string): unknown };
      source = {
        getSnapshot: () => views.get(target),
        subscribe: (listener) => {
          const unsubscribe = this.snapshot.subscribe(listener);
          this.activate(target);
          return unsubscribe;
        },
      };
      this.targetSources.set(target, source);
    }
    return source as ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined>;
  }

  activate(target: string): void {
    const activated = this.assembler.activateTarget(target);
    if (activated) {
      this.cancelScheduledFlush();
      this.snapshot.set(this.currentSnapshot());
    }
    this.openTurn.set(this.assembler.openTurn());
  }

  rebuild(): void {
    this.publish(this.assembler.rebuildRegistry());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduledFlush();
    this.disposeFeed();
  }

  private replace(window: SessionEventWindow): void {
    this.revision = window.revision;
    this.publish(this.assembler.replaceWindow(window.entries, window.hasMore));
  }

  private accept(window: SessionEventWindow): void {
    if (window.revision === this.revision) return;
    if (window.revision !== this.revision + 1 || window.change.kind === "replace") {
      this.replace(window);
      return;
    }
    this.revision = window.revision;
    switch (window.change.kind) {
      case "prepend":
        this.publish(this.assembler.prepend(window.change.entries, window.hasMore));
        return;
      case "append": {
        let publication: ConversationPublication = "none";
        for (const event of window.change.entries) {
          const next = this.assembler.append(event);
          if (next === "immediate" || publication === "none") publication = next;
        }
        this.publish(publication);
        return;
      }
      case "settle-assistant":
        this.publish(this.assembler.settleAssistant(window.change.attemptId, window.change.entry));
        return;
    }
  }

  private publish(publication: ConversationPublication): void {
    if (this.disposed || publication === "none") return;
    if (publication === "animation-frame") {
      if (isWindowHidden()) {
        this.deferWhileHidden();
        return;
      }
      this.scheduleCoalescedFlush();
      return;
    }
    this.cancelScheduledFlush();
    this.flush();
  }

  private scheduleCoalescedFlush(): void {
    if (this.disposed || this.timer !== undefined || this.frame !== undefined) return;
    this.detachVisibilityListeners();
    this.deferredWhileHidden = false;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed) return;
      if (isWindowHidden()) {
        this.deferWhileHidden();
        return;
      }
      if (typeof requestAnimationFrame === "function") {
        this.frame = requestAnimationFrame(() => {
          this.frame = undefined;
          if (this.disposed) return;
          if (isWindowHidden()) {
            this.deferWhileHidden();
            return;
          }
          this.flush();
        });
      } else {
        this.flush();
      }
    }, LIVE_STREAM_COALESCE_MS);
  }

  private deferWhileHidden(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.deferredWhileHidden = true;
    this.attachVisibilityListeners();
  }

  private attachVisibilityListeners(): void {
    if (this.disposed || this.disposeVisibilityListeners !== undefined) return;
    const onResume = (event?: Event): void => {
      if (this.disposed || !this.deferredWhileHidden || isWindowHidden(event)) return;
      this.deferredWhileHidden = false;
      this.detachVisibilityListeners();
      this.flush();
    };
    const onVisibilityChange = (): void => onResume();
    const onShellHiddenChange = (event: Event): void => onResume(event);
    const doc =
      typeof document !== "undefined" && typeof document.addEventListener === "function"
        ? document
        : undefined;
    const win =
      typeof window !== "undefined" && typeof window.addEventListener === "function"
        ? window
        : undefined;
    doc?.addEventListener("visibilitychange", onVisibilityChange);
    win?.addEventListener(SHELL_WINDOW_HIDDEN_EVENT, onShellHiddenChange);
    this.disposeVisibilityListeners = () => {
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
      win?.removeEventListener(SHELL_WINDOW_HIDDEN_EVENT, onShellHiddenChange);
    };
  }

  private detachVisibilityListeners(): void {
    const dispose = this.disposeVisibilityListeners;
    if (dispose === undefined) return;
    this.disposeVisibilityListeners = undefined;
    dispose();
  }

  private clearTimers(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.frame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.frame);
    }
    this.frame = undefined;
  }

  private cancelScheduledFlush(): void {
    this.clearTimers();
    this.deferredWhileHidden = false;
    this.detachVisibilityListeners();
  }

  private flush(): void {
    if (this.assembler.flush()) this.snapshot.set(this.currentSnapshot());
    this.openTurn.set(this.assembler.openTurn());
  }

  private currentSnapshot(): ConversationSnapshot {
    return {
      views: this.viewStore,
      activeTargets: this.assembler.activityTargets(),
    };
  }
}

interface BindingRecord {
  readonly source: SessionBinding;
  readonly binding: BoundConversation;
  disposeScope: () => void;
}

/** Root service owning Conversation registries and per-Session bindings. */
export class UiConversation extends Service {
  /** Registry of event matchers and target snapshot builders. */
  readonly events: ConversationEventRegistry;
  /** Registry of target View definitions. */
  readonly views: ConversationViewRegistry;
  /** Business grouping rules over already materialized target Nodes. */
  readonly groups: ConversationGroupRegistry;
  private readonly bindings = new WeakMapWithValues<SessionBinding, BindingRecord>();
  private readonly images: HistoricalImageCache;

  /**
   * @param ctx - owning Client context.
   * @param sessions - Session Controller object layer.
   */
  constructor(
    ctx: Context,
    private readonly sessions: ISessions,
  ) {
    super(ctx, "uiConversation");
    this.events = new ConversationEventRegistry(ctx);
    this.views = new ConversationViewRegistry(ctx);
    this.groups = new ConversationGroupRegistry(ctx, this.views);
    this.images = new HistoricalImageCache(ctx, sessions);
    const rebuild = (): void => {
      for (const record of this.bindings.values) record.binding.rebuild();
    };
    let rebuildQueued = false;
    const scheduleRebuild = (): void => {
      if (rebuildQueued) return;
      rebuildQueued = true;
      queueMicrotask(() => {
        rebuildQueued = false;
        rebuild();
      });
    };
    ctx.effect(() => {
      const disposeEvents = this.events.subscribe(scheduleRebuild);
      const disposeViews = this.views.subscribe(scheduleRebuild);
      const disposeGroups = this.groups.subscribe(scheduleRebuild);
      return () => {
        disposeGroups();
        disposeViews();
        disposeEvents();
        for (const record of [...this.bindings.values]) this.drop(record, true);
      };
    }, "ui-conversation assembly");
  }

  /**
   * Resolve the Conversation binding for one Controller binding or Session id.
   * @param source - Session binding or identity.
   * @returns stable Conversation binding.
   * @throws if the Session is unknown or its binding is no longer current.
   */
  binding(source: SessionBinding | SessionId): ConversationBinding {
    const sessionId = typeof source === "string" ? source : source.sessionId;
    const owner = typeof source === "string" ? this.sessions.binding(source) : source;
    if (owner === undefined)
      throw new Error(`uiConversation.binding: unknown session "${sessionId}"`);
    if (this.sessions.binding(sessionId) !== owner) {
      throw new Error(`uiConversation.binding: inactive session "${sessionId}"`);
    }
    const current = this.bindings.get(owner);
    if (current !== undefined) return current.binding;
    const binding = new BoundConversation(
      owner.eventSource,
      new ConversationNodeAssembler(this.events, this.views, this.groups),
    );
    const record: BindingRecord = { source: owner, binding, disposeScope: () => {} };
    this.bindings.set(owner, record);
    const disposeScope = owner.ctx.effect(
      () => () => {
        this.drop(record, false);
      },
      "ui-conversation binding",
    );
    record.disposeScope = () => {
      void disposeScope();
    };
    return binding;
  }

  /**
   * Resolve one session-authorized durable image URL, cached per Session so
   * every Conversation target shares one read and one browser URL.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference from a session event.
   * @returns browser URL valid until the Session binding is released.
   */
  imageUrl(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    return this.images.resolve(sessionId, attachment);
  }

  /**
   * Read a cached durable image URL synchronously when one is available.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference from a session event.
   * @returns current preview or canonical URL, if cached.
   */
  peekImageUrl(sessionId: SessionId, attachment: ImageAttachmentRef): string | undefined {
    return this.images.peek(sessionId, attachment);
  }

  /**
   * Adopt an already-displayable URL for one durable reference (see
   * HistoricalImageCache.seed): the transcript node then renders it without a
   * byte round-trip.
   * @param sessionId - Session authorization scope.
   * @param attachment - Durable image reference the URL displays.
   * @param url - browser URL to adopt.
   * @param bytes - optional backing image size for LRU budget accounting.
   * @returns whether the cache took URL ownership.
   */
  seedImageUrl(
    sessionId: SessionId,
    attachment: ImageAttachmentRef,
    url: string,
    bytes?: number,
  ): boolean {
    return this.images.seed(sessionId, attachment, url, bytes);
  }

  /**
   * Cache a locally uploaded image Blob under its upload receipt identity and
   * fallback indices so the rendered message reuses local bytes without RPC.
   */
  cacheUploadedImage(sessionId: SessionId, uploaded: UploadedImageCacheEntry): boolean {
    return this.images.cacheUploaded(sessionId, uploaded);
  }

  /**
   * Bind an observed message image reference to a previously uploaded image
   * entry in the shared LRU cache.
   */
  aliasUploadedImage(
    sessionId: SessionId,
    uploadedAttachmentId: string,
    target: ImageAttachmentRef,
  ): boolean {
    return this.images.aliasUploaded(sessionId, uploadedAttachmentId, target);
  }

  /**
   * Clear pending-name fallback matching for an uploaded draft that was
   * removed before submission.
   */
  clearPendingUploadedImage(sessionId: SessionId, uploadedAttachmentId: string): void {
    this.images.clearPendingUploaded(sessionId, uploadedAttachmentId);
  }

  /**
   * Interpret a system message or surface replacement for target-owned prompt Definitions.
   * @param previous - System facts at the preceding relevant loaded event.
   * @param event - Durable system message or positional replacement.
   * @returns Immutable prompt interpretation at this event.
   */
  inspectSystemPrompt(
    previous: SystemPromptState | undefined,
    event: SessionEvent,
  ): SystemPromptState {
    return inspectSystemPrompt(previous, event);
  }

  /**
   * Canonicalize one `request/header` event against the previous prompt state
   * and the `system/message` node in force.
   *
   * A pure interpretation shared by the Chat and Trajectory Definitions, exposed
   * as a service method because cross-plugin value imports are forbidden in
   * client bundles.
   * @param previous - prompt recorded by the preceding loaded header, if any.
   * @param event - the `request/header` session event to interpret.
   * @param system - effective prompt after loaded surface replacements, if any.
   * @returns the canonical prompt snapshot and any model-visible change.
   */
  inspectRequestPrompt(
    previous: ConversationPromptSnapshot | undefined,
    event: SessionEvent<"request/header">,
    system: SystemPromptNode | undefined,
  ): RequestPromptInspection {
    return inspectRequestPrompt(previous, event, system);
  }

  private drop(record: BindingRecord, releaseScope: boolean): void {
    if (this.bindings.get(record.source) !== record) return;
    this.bindings.delete(record.source);
    record.binding.dispose();
    if (releaseScope) record.disposeScope();
  }
}
