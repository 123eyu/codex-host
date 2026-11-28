/** Cursor encoding and bounded page selection for remote sessions in `session/list`. */

export const REMOTE_LIST_PAGE_SIZE = 50;
export const REMOTE_WORKSPACE_HEAD_LIMIT = 6;
export const REMOTE_LIST_MAX_HEAD_NON_PRIORITY = 150;
export const REMOTE_WORKSPACE_PAGE_SIZE = 50;

export interface RemoteGlobalListCursor {
  readonly kind: "global";
  readonly includeArchived: boolean;
  readonly localCursor: string | null;
  readonly remoteOffset: number;
}

export interface RemoteWorkspaceListCursor {
  readonly kind: "workspace";
  readonly workspaceId: string;
  readonly includeArchived: boolean;
  readonly offset: number;
}

export type RemoteListCursor = RemoteGlobalListCursor | RemoteWorkspaceListCursor;

export function encodeRemoteGlobalCursor(input: {
  includeArchived: boolean;
  localCursor: string | null;
  remoteOffset: number;
}): string {
  return JSON.stringify({
    codexhostRemoteCursor: 1,
    includeArchived: input.includeArchived,
    localCursor: input.localCursor,
    remoteOffset: input.remoteOffset,
  });
}

export function encodeRemoteWorkspaceCursor(input: {
  workspaceId: string;
  includeArchived: boolean;
  offset: number;
}): string {
  return JSON.stringify({
    codexhostRemoteWorkspaceCursor: 1,
    workspaceId: input.workspaceId,
    includeArchived: input.includeArchived,
    offset: input.offset,
  });
}

export function parseRemoteListCursor(cursor: string): RemoteListCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.codexhostRemoteCursor === 1) {
    if (
      typeof record.includeArchived !== "boolean" ||
      (record.localCursor !== null && typeof record.localCursor !== "string") ||
      typeof record.remoteOffset !== "number" ||
      !Number.isSafeInteger(record.remoteOffset) ||
      record.remoteOffset < 0
    ) {
      return undefined;
    }
    return {
      kind: "global",
      includeArchived: record.includeArchived,
      localCursor: record.localCursor,
      remoteOffset: record.remoteOffset,
    };
  }
  if (record.codexhostRemoteWorkspaceCursor === 1) {
    if (
      typeof record.workspaceId !== "string" ||
      record.workspaceId.length === 0 ||
      typeof record.includeArchived !== "boolean" ||
      typeof record.offset !== "number" ||
      !Number.isSafeInteger(record.offset) ||
      record.offset < 0
    ) {
      return undefined;
    }
    return {
      kind: "workspace",
      workspaceId: record.workspaceId,
      includeArchived: record.includeArchived,
      offset: record.offset,
    };
  }
  return undefined;
}

export interface RemoteHeadPageSelection {
  readonly ids: string[];
  readonly hasMore: boolean;
  readonly nextRemoteOffset: number;
}

function appendWithAncestors(
  target: Set<string>,
  id: string,
  ancestorsOf: (sessionId: string) => readonly string[],
): void {
  if (!target.has(id)) target.add(id);
  for (const ancestorId of ancestorsOf(id)) {
    if (!target.has(ancestorId)) target.add(ancestorId);
  }
}

/**
 * Select the initial remote page for `session/list`:
 * - Always retains priority sessions (pinned, running, pending interactions, open views).
 * - Includes the top `pageSize` most recent entries globally, plus up to `workspaceHeadLimit`
 *   recent entries per remote workspace (bounded by `maxHeadNonPriority`).
 * - Pulls ancestor chains for every selected session so thread trees stay connected.
 */
export function selectRemoteHeadPage(options: {
  readonly orderedIds: readonly string[];
  readonly priorityIds: ReadonlySet<string>;
  readonly workspaceIdOf: (sessionId: string) => string | undefined;
  readonly ancestorsOf: (sessionId: string) => readonly string[];
  readonly pageSize?: number;
  readonly workspaceHeadLimit?: number;
  readonly maxHeadNonPriority?: number;
}): RemoteHeadPageSelection {
  const {
    orderedIds,
    priorityIds,
    workspaceIdOf,
    ancestorsOf,
    pageSize = REMOTE_LIST_PAGE_SIZE,
    workspaceHeadLimit = REMOTE_WORKSPACE_HEAD_LIMIT,
    maxHeadNonPriority = REMOTE_LIST_MAX_HEAD_NON_PRIORITY,
  } = options;

  const selected = new Set<string>();
  const workspaceCounts = new Map<string, number>();

  for (const id of priorityIds) {
    appendWithAncestors(selected, id, ancestorsOf);
  }

  let nonPriorityCount = 0;
  for (let index = 0; index < orderedIds.length; index++) {
    const id = orderedIds[index]!;
    const wsId = workspaceIdOf(id);
    if (selected.has(id)) {
      if (wsId !== undefined) {
        workspaceCounts.set(wsId, (workspaceCounts.get(wsId) ?? 0) + 1);
      }
      continue;
    }
    const inHeadSlice = index < pageSize;
    const wsCount = wsId === undefined ? workspaceHeadLimit : (workspaceCounts.get(wsId) ?? 0);
    const inWorkspacePreview =
      wsId !== undefined && wsCount < workspaceHeadLimit && nonPriorityCount < maxHeadNonPriority;
    if (!inHeadSlice && !inWorkspacePreview) continue;
    appendWithAncestors(selected, id, ancestorsOf);
    nonPriorityCount += 1;
    if (wsId !== undefined) {
      workspaceCounts.set(wsId, wsCount + 1);
    }
  }

  let hasMore = false;
  for (const id of orderedIds) {
    if (!selected.has(id)) {
      hasMore = true;
      break;
    }
  }

  // Entries 0..pageSize-1 are always selected on page 1, so global continuation resumes at pageSize.
  const nextRemoteOffset = hasMore ? Math.min(pageSize, orderedIds.length) : orderedIds.length;
  return {
    ids: [...selected],
    hasMore,
    nextRemoteOffset,
  };
}

export function selectRemoteSlicePage(options: {
  readonly orderedIds: readonly string[];
  readonly offset: number;
  readonly pageSize: number;
  readonly ancestorsOf: (sessionId: string) => readonly string[];
}): { readonly ids: string[]; readonly hasMore: boolean; readonly nextOffset: number } {
  const { orderedIds, offset, pageSize, ancestorsOf } = options;
  const start = Math.max(0, Math.min(offset, orderedIds.length));
  const end = Math.min(start + pageSize, orderedIds.length);
  const selected = new Set<string>();
  for (let index = start; index < end; index++) {
    appendWithAncestors(selected, orderedIds[index]!, ancestorsOf);
  }
  return {
    ids: [...selected],
    hasMore: end < orderedIds.length,
    nextOffset: end,
  };
}
