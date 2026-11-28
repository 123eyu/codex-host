import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientInteraction } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import type { PeerChHostClient } from "../src/peer-ch-host-client.ts";
import { PeerThreadSource } from "../src/peer-thread-source.ts";
import {
  RemoteSessions,
  remoteSessionId,
  type RemotePeerProvider,
} from "../src/remote-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry, type StreamSink } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

function eventSink() {
  const frames: Array<Record<string, unknown>> = [];
  const cleanups: Array<() => void> = [];
  let closed = false;
  const sink: StreamSink = {
    id: "events-test",
    get closed() {
      return closed;
    },
    push: (frame) => frames.push(frame as Record<string, unknown>),
    end() {
      closed = true;
      for (const stop of cleanups.splice(0)) stop();
    },
    fail(code, message) {
      throw new Error(`${code}: ${message}`);
    },
    onClose: (fn) => cleanups.push(fn),
  };
  return { frames, sink };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out waiting for condition");
    await delay(10);
  }
}

function makeApproval(threadId: string, requestId: string | number): ClientInteraction {
  return {
    requestId,
    threadId,
    kind: "approval",
    interaction: {
      type: "approval",
      title: "Allow running command?",
      actions: [
        { id: "accept", label: "Allow once", effect: "allowOnce" },
        { id: "decline", label: "Decline", effect: "deny" },
      ],
    },
    request: {
      method: "item/commandExecution/requestApproval",
      params: { command: "echo hi", availableDecisions: ["accept", "decline"] },
    },
  };
}

function makeQuestion(threadId: string, requestId: string | number): ClientInteraction {
  return {
    requestId,
    threadId,
    kind: "question",
    interaction: {
      type: "question",
      title: "Pick an option",
      questions: [
        {
          id: "q1",
          prompt: "Choose A or B",
          type: "choice",
          multiple: false,
          allowOther: false,
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      ],
    },
    request: {
      method: "item/tool/requestUserInput",
      params: {},
    },
  };
}

it("discovers, answers, and withdraws pending interactions on unwatched local threads without session/follow", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-bg-interactions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel();
  host.add("bg-thread", root);

  const events = new EventHub(root);
  const client = eventSink();
  events.handler({}, client.sink);
  t.after(() => client.sink.end());

  const sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events);
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  sessions.register(rpc, streams);
  await rpc.dispatch("session/list", { args: {} });

  // No session/follow was opened; thread has no view in WebThreadStates.
  assert.equal(host.snapshots, 0);
  assert.equal(sessions["threads"].view("bg-thread"), undefined);

  // 1. Approval request on unwatched thread emits waterfall via bounded truncated snapshot.
  host.pending = [makeApproval("bg-thread", "req-approval-1")];
  host.changed("bg-thread", "item/commandExecution/requestApproval");
  await waitFor(() => client.frames.some((frame) => frame.type === "waterfall"));

  assert.equal(sessions["threads"].view("bg-thread"), undefined);
  assert.deepEqual(host.snapshotOptions, [{ truncateToolOutput: true }]);

  const firstWaterfall = client.frames.find((frame) => frame.type === "waterfall");
  assert.ok(firstWaterfall);
  assert.equal(firstWaterfall.event, "user-questions/request");
  assert.equal(firstWaterfall.agentId, "bg-thread");

  // Answering the background interaction forwards the response to the Host.
  const clientId = String(client.frames[0]?.clientId);
  events.settle({
    clientId,
    eventId: String(firstWaterfall.eventId),
    outcome: {
      kind: "returned",
      value: { answers: [{ id: "approval", selected: ["Allow once"] }] },
    },
  });
  await waitFor(() => host.answers.length === 1);
  assert.equal(host.answers[0]?.requestId, "req-approval-1");
  assert.deepEqual(host.answers[0]?.result, { decision: "accept" });

  // 2. Question request on unwatched thread emits a second waterfall, and serverRequest/resolved
  // withdraws it cleanly without requiring session/follow.
  host.pending = [makeQuestion("bg-thread", "req-question-2")];
  host.changed("bg-thread", "item/tool/requestUserInput");
  await waitFor(() => client.frames.filter((frame) => frame.type === "waterfall").length === 2);
  const secondWaterfall = client.frames.filter((frame) => frame.type === "waterfall")[1];
  assert.ok(secondWaterfall);

  host.pending = [];
  host.changed("bg-thread", "serverRequest/resolved");
  await waitFor(() =>
    client.frames.some(
      (frame) => frame.type === "cancel" && frame.eventId === secondWaterfall.eventId,
    ),
  );
  assert.equal(sessions["threads"].view("bg-thread"), undefined);
});

it("reconciles already-pending interactions on active unwatched local threads during catalog load", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-bg-initial-interactions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("active-bg", root);
  row.status = { type: "active" };
  host.pending = [makeApproval("active-bg", "req-preexisting")];

  const events = new EventHub(root);
  const client = eventSink();
  events.handler({}, client.sink);
  t.after(() => client.sink.end());

  const sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events);
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  await rpc.dispatch("session/list", { args: {} });

  await waitFor(() => client.frames.some((frame) => frame.type === "waterfall"));
  const waterfall = client.frames.find((frame) => frame.type === "waterfall");
  assert.ok(waterfall);
  assert.equal(waterfall.agentId, "active-bg");
  assert.equal(sessions["threads"].view("active-bg"), undefined);
  assert.deepEqual(host.snapshotOptions, [{ truncateToolOutput: true }]);
});

it("discovers and withdraws pending interactions on unwatched remote peer threads without readPeer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-peer-bg-interactions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hostId = "remote-peer:peer-1";
  const peerChannel = new FakeChChannel();
  peerChannel.add("peer-thread", root);
  const peerHost = Object.assign(peerChannel, {
    manifestEpoch: () => peerChannel.epoch,
  }) as unknown as PeerChHostClient;

  let onThreadInteraction: ((hostId: string, threadId: string) => unknown) | undefined;
  let onThreadChanged: ((hostId: string, threadId: string) => unknown) | undefined;
  let onConnection: ((hostId: string, online: boolean) => void) | undefined;
  let onReset: ((hostId: string, epoch: string, full: boolean) => void) | undefined;

  const source = new PeerThreadSource({
    hostId,
    host: peerHost,
    onCatalogChanged: () => {},
    onThreadChanged: (threadId) => onThreadChanged?.(hostId, threadId),
    onThreadInteraction: (threadId) => onThreadInteraction?.(hostId, threadId),
    onConnection: (online) => onConnection?.(hostId, online),
    onReset: (epoch, full) => onReset?.(hostId, epoch, full),
  });
  t.after(() => source.close());

  const provider: RemotePeerProvider = {
    source: (candidate) => (candidate === hostId ? source : undefined),
    get onThreadChanged() {
      return onThreadChanged;
    },
    set onThreadChanged(fn) {
      onThreadChanged = fn;
    },
    get onThreadInteraction() {
      return onThreadInteraction;
    },
    set onThreadInteraction(fn) {
      onThreadInteraction = fn;
    },
    get onConnection() {
      return onConnection;
    },
    set onConnection(fn) {
      onConnection = fn;
    },
    get onReset() {
      return onReset;
    },
    set onReset(fn) {
      onReset = fn;
    },
  };

  const events = new EventHub(root);
  const client = eventSink();
  events.handler({}, client.sink);
  t.after(() => client.sink.end());

  const remoteSessions = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [{ hostId, online: true, epoch: peerChannel.epoch, displayName: "Peer 1" }];
      }
      return [];
    },
    undefined,
    provider,
  );
  t.after(() => remoteSessions.close());

  const expectedSessionId = remoteSessionId(hostId, "peer-thread");
  assert.equal(peerChannel.snapshots, 0);

  // Trigger an approval event on the unwatched remote peer thread.
  peerChannel.pending = [makeApproval("peer-thread", "peer-req-1")];
  peerChannel.changed("peer-thread", "item/commandExecution/requestApproval");

  await waitFor(() => client.frames.some((frame) => frame.type === "waterfall"));
  const waterfall = client.frames.find((frame) => frame.type === "waterfall");
  assert.ok(waterfall);
  assert.equal(waterfall.event, "user-questions/request");
  assert.equal(waterfall.agentId, expectedSessionId);
  assert.deepEqual(peerChannel.snapshotOptions, [{ truncateToolOutput: true }]);
  // No full history view was materialized for the unwatched peer thread.
  assert.equal(source["histories"].size, 0);

  // Resolving on the peer withdraws the pending waterfall cleanly without session/follow.
  peerChannel.pending = [];
  peerChannel.changed("peer-thread", "serverRequest/resolved");
  await waitFor(() =>
    client.frames.some((frame) => frame.type === "cancel" && frame.eventId === waterfall.eventId),
  );
  assert.equal(source["histories"].size, 0);
});

it("does not wedge remote peer interaction reconciliation after an offline early exit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-peer-bg-offline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hostId = "remote-peer:peer-offline";
  const peerChannel = new FakeChChannel();
  peerChannel.add("peer-thread", root);
  const peerHost = Object.assign(peerChannel, {
    manifestEpoch: () => peerChannel.epoch,
  }) as unknown as PeerChHostClient;

  let onThreadInteraction: ((hostId: string, threadId: string) => unknown) | undefined;
  let onConnection: ((hostId: string, online: boolean) => void) | undefined;
  const source = new PeerThreadSource({
    hostId,
    host: peerHost,
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onThreadInteraction: (threadId) => onThreadInteraction?.(hostId, threadId),
    onConnection: (online) => onConnection?.(hostId, online),
  });
  t.after(() => source.close());

  const provider: RemotePeerProvider = {
    source: (candidate) => (candidate === hostId ? source : undefined),
    get onThreadInteraction() {
      return onThreadInteraction;
    },
    set onThreadInteraction(fn) {
      onThreadInteraction = fn;
    },
    get onConnection() {
      return onConnection;
    },
    set onConnection(fn) {
      onConnection = fn;
    },
  };

  let peerOnline = false;
  const events = new EventHub(root);
  const client = eventSink();
  events.handler({}, client.sink);
  t.after(() => client.sink.end());

  const remoteSessions = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          { hostId, online: peerOnline, epoch: peerChannel.epoch, displayName: "Peer Offline" },
        ];
      }
      return [];
    },
    undefined,
    provider,
  );
  t.after(() => remoteSessions.close());

  // Populate offline host state, then trigger an interaction event while offline.
  await remoteSessions.refresh(hostId);
  peerChannel.pending = [makeApproval("peer-thread", "peer-offline-req")];
  await onThreadInteraction?.(hostId, "peer-thread");
  assert.equal(peerChannel.snapshots, 0);

  // Bring the peer back online; subsequent interaction notifications must not be wedged.
  peerOnline = true;
  await remoteSessions.refresh(hostId);
  peerChannel.changed("peer-thread", "item/commandExecution/requestApproval");
  await waitFor(() => client.frames.some((frame) => frame.type === "waterfall"));
  assert.equal(
    client.frames.find((frame) => frame.type === "waterfall")?.agentId,
    remoteSessionId(hostId, "peer-thread"),
  );
});

it("retries failed initial background interaction sync, handles epoch switches, and ignores deleted threads", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-bg-races-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("race-thread", root);
  row.status = { type: "active" };
  host.pending = [makeApproval("race-thread", "req-retry-1")];

  const baseSnapshot = host.realtime.snapshot.bind(host.realtime);
  let snapshotAttempt = 0;
  let holdSnapshot: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  host.realtime.snapshot = async (threadId, options) => {
    snapshotAttempt += 1;
    if (snapshotAttempt === 1) {
      throw new Error("transient snapshot failure");
    }
    const snapshot = await baseSnapshot(threadId, options);
    if (holdSnapshot) {
      const gate = holdSnapshot;
      holdSnapshot = undefined;
      await gate.promise;
    }
    return snapshot;
  };

  const events = new EventHub(root);
  const client = eventSink();
  events.handler({}, client.sink);
  t.after(() => client.sink.end());

  const sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events);
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());

  // 1. First catalog load fails snapshot transiently; second catalog load retries and discovers approval.
  await rpc.dispatch("session/list", { args: {} });
  await waitFor(() => snapshotAttempt === 1);
  assert.equal(client.frames.filter((frame) => frame.type === "waterfall").length, 0);

  await rpc.dispatch("session/list", { args: {} });
  await waitFor(() => client.frames.filter((frame) => frame.type === "waterfall").length === 1);

  // 2. While an old-epoch snapshot is in flight, a new epoch + interaction arrives; it must be reconciled.
  const epochGate = Promise.withResolvers<void>();
  holdSnapshot = epochGate;
  host.changed("race-thread", "item/tool/requestUserInput");
  await waitFor(() => snapshotAttempt === 3);

  host.epoch = randomUUID();
  host.pending = [makeQuestion("race-thread", "req-epoch-2")];
  for (const listener of host.listeners) {
    listener({
      type: "hello",
      version: 1,
      cursor: { epoch: host.epoch, sequence: ++host.sequence },
      reset: true,
    });
  }
  host.changed("race-thread", "item/tool/requestUserInput");
  epochGate.resolve();
  await waitFor(() => client.frames.filter((frame) => frame.type === "waterfall").length === 2);

  // 3. Deleting a thread while its background snapshot is in flight must not revive a zombie card.
  const deleteGate = Promise.withResolvers<void>();
  holdSnapshot = deleteGate;
  host.pending = [makeApproval("race-thread", "req-zombie")];
  host.changed("race-thread", "item/commandExecution/requestApproval");
  await waitFor(() => snapshotAttempt === 5);

  host.changed("race-thread", "thread/deleted");
  const waterfallsBeforeDeleteResolve = client.frames.filter(
    (frame) => frame.type === "waterfall",
  ).length;
  deleteGate.resolve();
  await delay(30);
  assert.equal(
    client.frames.filter((frame) => frame.type === "waterfall").length,
    waterfallsBeforeDeleteResolve,
  );
});
