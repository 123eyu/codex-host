import assert from "node:assert/strict";
import { it } from "node:test";
import {
  REMOTE_LIST_PAGE_SIZE,
  REMOTE_WORKSPACE_HEAD_LIMIT,
  encodeRemoteGlobalCursor,
  encodeRemoteWorkspaceCursor,
  parseRemoteListCursor,
  selectRemoteHeadPage,
  selectRemoteSlicePage,
} from "../src/remote-session-list.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { remoteWorkspaceId } from "../src/remote-workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";

it("selects bounded remote head page while preserving priorities, workspace previews, and ancestors", () => {
  const orderedIds = Array.from({ length: 120 }, (_, i) => `s-${String(i).padStart(3, "0")}`);
  const wsMap = new Map<string, string>();
  for (let i = 0; i < orderedIds.length; i++) {
    wsMap.set(orderedIds[i]!, i < 90 ? "ws-a" : "ws-b");
  }
  const priorityIds = new Set(["s-115"]);
  const ancestors = new Map<string, string[]>([["s-115", ["s-118", "s-119"]]]);

  const head = selectRemoteHeadPage({
    orderedIds,
    priorityIds,
    workspaceIdOf: (id) => wsMap.get(id),
    ancestorsOf: (id) => ancestors.get(id) ?? [],
  });

  assert.equal(head.hasMore, true);
  assert.equal(head.nextRemoteOffset, REMOTE_LIST_PAGE_SIZE);
  // Top 50 recent globally + priority s-115 + ancestors s-118/s-119 + ws-b preview (6 items)
  assert.ok(head.ids.includes("s-000"));
  assert.ok(head.ids.includes("s-049"));
  assert.ok(head.ids.includes("s-115"));
  assert.ok(head.ids.includes("s-118"));
  assert.ok(head.ids.includes("s-119"));
  const wsBInHead = head.ids.filter((id) => wsMap.get(id) === "ws-b");
  assert.ok(wsBInHead.length >= REMOTE_WORKSPACE_HEAD_LIMIT);
  assert.ok(head.ids.length < orderedIds.length);

  // Subsequent global pages cover every remaining item from nextRemoteOffset onward.
  const page2 = selectRemoteSlicePage({
    orderedIds,
    offset: head.nextRemoteOffset,
    pageSize: REMOTE_LIST_PAGE_SIZE,
    ancestorsOf: () => [],
  });
  assert.equal(page2.ids.length, 50);
  assert.equal(page2.hasMore, true);
  assert.equal(page2.nextOffset, 100);

  const page3 = selectRemoteSlicePage({
    orderedIds,
    offset: page2.nextOffset,
    pageSize: REMOTE_LIST_PAGE_SIZE,
    ancestorsOf: () => [],
  });
  assert.equal(page3.ids.length, 20);
  assert.equal(page3.hasMore, false);
});

it("round-trips global and workspace remote cursors and ignores plain local cursors", () => {
  const globalEncoded = encodeRemoteGlobalCursor({
    includeArchived: false,
    localCursor: '{"includeArchived":false,"officialCursor":{"live":"abc"}}',
    remoteOffset: 50,
  });
  assert.deepEqual(parseRemoteListCursor(globalEncoded), {
    kind: "global",
    includeArchived: false,
    localCursor: '{"includeArchived":false,"officialCursor":{"live":"abc"}}',
    remoteOffset: 50,
  });

  const wsEncoded = encodeRemoteWorkspaceCursor({
    workspaceId: "remote-workspace:h:p",
    includeArchived: true,
    offset: 100,
  });
  assert.deepEqual(parseRemoteListCursor(wsEncoded), {
    kind: "workspace",
    workspaceId: "remote-workspace:h:p",
    includeArchived: true,
    offset: 100,
  });

  assert.equal(
    parseRemoteListCursor('{"includeArchived":false,"officialCursor":{"live":"x"}}'),
    undefined,
  );
  assert.equal(parseRemoteListCursor("not-json"), undefined);
});

it("paginates remote sessions in session/list, supports remote workspace paging, unwraps local workspace cursors, and omits defaultProjections bloat", async (t) => {
  const hostId = "remote-control:host-big";
  const rows = Array.from({ length: 130 }, (_, index) => ({
    id: `t-${String(index).padStart(3, "0")}`,
    cwd: index < 80 ? "/repo-a" : "/repo-b",
    modelProvider: "codex",
    preview: `Thread ${index}`,
    createdAt: 1000 + index,
    updatedAt: 2000 + index,
    status: { type: index === 0 ? "active" : "idle" },
    turns: [],
  }));
  const localCursorCalls: Array<{ cursor?: unknown; workspaceId?: unknown }> = [];
  const remote = new RemoteSessions(new EventHub("remote-list-test"), async (op) => {
    if (op.kind === "hosts") {
      return [
        {
          hostId,
          online: true,
          epoch: "e1",
          displayName: "Big Remote",
          projects: [
            { id: "p-a", name: "Repo A", path: "/repo-a", threadIds: [] },
            { id: "p-b", name: "Repo B", path: "/repo-b", threadIds: [] },
          ],
        },
      ];
    }
    if (op.kind === "list") return { data: rows, nextCursor: null, epoch: "e1" };
    throw new Error(`unexpected op ${op.kind}`);
  });
  t.after(() => remote.close());
  await remote.refresh();

  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  remote.install(rpc, streams);
  rpc.register("session/list", (args) => {
    const req = (
      typeof args.request === "object" && args.request !== null ? args.request : args
    ) as { cursor?: unknown; workspaceId?: unknown };
    localCursorCalls.push({ cursor: req.cursor, workspaceId: req.workspaceId });
    if (req.workspaceId === "local-ws-1") {
      return { items: [{ sessionId: "local-older" }], archivedSessionIds: [], nextCursor: null };
    }
    if (req.cursor === "local-c1") {
      return { items: [{ sessionId: "local-page-2" }], archivedSessionIds: [], nextCursor: null };
    }
    return { items: [{ sessionId: "local-1" }], archivedSessionIds: [], nextCursor: "local-c1" };
  });

  // 1. Head page is bounded, includes active remote t-000 + slim summaries (no defaultProjections bloat).
  const headRes = (await rpc.dispatch("session/list", { args: { request: {} } })) as {
    ok: true;
    value: {
      items: Array<{ sessionId: string; projections?: { values: Record<string, unknown> } }>;
      nextCursor: string | null;
    };
  };
  assert.equal(headRes.ok, true);
  assert.ok(headRes.value.nextCursor !== null);
  const remoteHeadItems = headRes.value.items.filter((i) => i.sessionId.startsWith("web-remote:"));
  assert.ok(remoteHeadItems.length >= REMOTE_LIST_PAGE_SIZE);
  assert.ok(remoteHeadItems.length < rows.length);
  const activeId = remoteSessionId(hostId, "t-000");
  assert.ok(remoteHeadItems.some((i) => i.sessionId === activeId));
  // Slim summary must not include heavy defaultProjections control keys.
  const sampleProj = remoteHeadItems[0]?.projections?.values ?? {};
  assert.equal("codexhostUsage" in sampleProj, false);
  assert.equal("permissions" in sampleProj, false);
  assert.equal("turnOutline" in sampleProj, false);
  assert.ok("title" in sampleProj);
  assert.ok("remoteHost" in sampleProj);

  // 2. Local workspace continuation unwraps localCursor (including wrapped args.request) and never appends remote items.
  const localWsRes = (await rpc.dispatch("session/list", {
    args: { request: { cursor: headRes.value.nextCursor, workspaceId: "local-ws-1" } },
  })) as { ok: true; value: { items: Array<{ sessionId: string }>; nextCursor: string | null } };
  assert.equal(localWsRes.ok, true);
  assert.deepEqual(
    localWsRes.value.items.map((i) => i.sessionId),
    ["local-older"],
  );
  assert.equal(localCursorCalls.at(-1)?.cursor, "local-c1");

  // 3. Remote workspace continuation paginates only that remote workspace's entries.
  const remoteWsId = remoteWorkspaceId(hostId, "p-a");
  const wsPage1 = (await rpc.dispatch("session/list", {
    args: { request: { cursor: headRes.value.nextCursor, workspaceId: remoteWsId } },
  })) as { ok: true; value: { items: Array<{ sessionId: string }>; nextCursor: string | null } };
  assert.equal(wsPage1.ok, true);
  assert.equal(wsPage1.value.items.length, 50);
  assert.ok(wsPage1.value.nextCursor !== null);
  const wsPage2 = (await rpc.dispatch("session/list", {
    args: { request: { cursor: wsPage1.value.nextCursor, workspaceId: remoteWsId } },
  })) as { ok: true; value: { items: Array<{ sessionId: string }>; nextCursor: string | null } };
  assert.equal(wsPage2.ok, true);
  assert.equal(wsPage2.value.items.length, 30);
  assert.equal(wsPage2.value.nextCursor, null);

  // 4. Global loadMore advances both localCursor and remote pages until exhausted.
  const globalPage2 = (await rpc.dispatch("session/list", {
    args: { request: { cursor: headRes.value.nextCursor } },
  })) as { ok: true; value: { items: Array<{ sessionId: string }>; nextCursor: string | null } };
  assert.equal(globalPage2.ok, true);
  assert.ok(globalPage2.value.items.some((i) => i.sessionId === "local-page-2"));
  assert.ok(globalPage2.value.nextCursor !== null);

  const globalPage3 = (await rpc.dispatch("session/list", {
    args: { request: { cursor: globalPage2.value.nextCursor } },
  })) as { ok: true; value: { items: Array<{ sessionId: string }>; nextCursor: string | null } };
  assert.equal(globalPage3.ok, true);
  assert.equal(globalPage3.value.nextCursor, null);
});
