import { Context } from "@deepseek-ai/cordis";
import { LlmAttemptId, MessageId } from "@deepseek-ai/dsh-llm/brand";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MutableSessionEventSource,
  type SessionLiveEventEntry,
} from "../../../api/session-controller/src/client/contract/events.ts";
import type {
  ISessions,
  SessionBinding,
} from "../../../api/session-controller/src/client/contract/sessions.ts";
import { ClientAssistantStream } from "../../../api/session-controller/src/client/sessions/assistant-stream.ts";
import type { ChatNode } from "../../ui-chat/src/client/contract/chat-nodes.ts";
import { assistantDefinition } from "../../ui-chat/src/client/conversation-nodes/assistant.ts";
import { chatViewDefinition } from "../../ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts";
import { ConversationNodeAssembler } from "../src/client/conversation/assembler.ts";
import { LIVE_STREAM_COALESCE_MS, UiConversation } from "../src/client/conversation/assembly.ts";

it.each([
  { path: "live frames", baselineSize: 0 },
  { path: "a reconnect baseline and live frames", baselineSize: 6_000 },
])("keeps every fragment of a long Web reply from $path", ({ baselineSize }) => {
  const origin = 2 ** 40;
  const turn = 2;
  const step = 1;
  const attemptId = LlmAttemptId("long-reply");
  const startedAfterSeq = SessionSeq(origin + 1);
  const entries: SessionLiveEventEntry[] = [
    {
      type: "event",
      event: { type: "turn/start", seq: SessionSeq(origin), time: 1, data: { turn } },
    },
    {
      type: "event",
      event: { type: "step/start", seq: startedAfterSeq, time: 2, data: { turn, step } },
    },
  ];
  const texts = Array.from({ length: 12_000 }, (_, index) => ` ${index}`);
  const expected = texts.join("");
  const stream = new ClientAssistantStream();
  const assembler = new ConversationNodeAssembler(
    { entries: () => [assistantDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  );
  assembler.activateTarget("chat");

  if (baselineSize > 0) {
    assembler.replaceWindow(
      stream.replace(entries, {
        revision: baselineSize + 1,
        activeAttempt: {
          attemptId,
          startedAfterSeq,
          turn,
          step,
          nextIndex: baselineSize,
          stream: [
            {
              type: "text-chunks",
              index: 0,
              time0: 3,
              dt: Array.from({ length: baselineSize - 1 }, () => 1),
              texts: texts.slice(0, baselineSize),
            },
          ],
        },
      }),
      true,
    );
  } else {
    assembler.replaceWindow(stream.replace(entries), true);
    stream.acceptFrame({ type: "start", revision: 1, attemptId, startedAfterSeq, turn, step });
  }
  for (let index = baselineSize; index < texts.length; index++) {
    const result = stream.acceptFrame({
      type: "chunk",
      revision: index + 2,
      attemptId,
      index,
      time: index + 3,
      chunk: { type: "text-delta", index: 0, text: texts[index]! },
    });
    if (result?.type !== "transient") throw new Error("Expected a live assistant chunk");
    assembler.append(result.entry);
  }

  function reply() {
    assembler.flush();
    const chat = assembler.get("chat");
    const node = chat?.nodes.values().find((node) => node.kind === "assistant-step") as
      ChatNode<"assistant-step"> | undefined;
    if (!node) throw new Error("Expected the assistant reply in the Chat snapshot");
    const text = node.data.blocks
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("");
    return { text, status: node.data.status, anchor: node.anchorSeq };
  }
  const live = reply();
  expect(live.text.length).toBe(expected.length);
  expect(live).toMatchObject({ text: expected, status: "running" });

  assembler.prepend(
    [
      {
        type: "event",
        event: { type: "turn/start", seq: SessionSeq(origin - 2), time: 0, data: { turn: 1 } },
      },
      {
        type: "event",
        event: {
          type: "turn/end",
          seq: SessionSeq(origin - 1),
          time: 0,
          data: { turn: 1, reason: { kind: "completed" } },
        },
      },
    ],
    false,
  );
  expect(reply()).toEqual(live);
  expect(assembler.get("chat")?.timeline.turns.get(turn)?.steps[0]?.start?.seq).toBe(
    startedAfterSeq,
  );

  const messageSeq = SessionSeq(origin + 2);
  stream.acceptDurable({
    type: "event",
    event: {
      type: "assistant/message",
      seq: messageSeq,
      time: texts.length + 3,
      surfaceOp: "append",
      data: {
        turn,
        step,
        stream: [],
        message: {
          id: MessageId("reply"),
          role: "assistant",
          source: { kind: "model", provider: "test", model: "test" },
          content: [{ type: "text", text: expected }],
        },
      },
    },
  });
  const result = stream.acceptFrame({
    type: "end",
    revision: texts.length + 2,
    attemptId,
    index: texts.length,
    outcome: { kind: "committed", eventType: "assistant/message", seq: messageSeq },
  });
  if (result?.type !== "publish") throw new Error("Expected a settled assistant reply");
  assembler.append(result.entry);
  expect(reply()).toEqual({ ...live, status: "settled" });

  const closed = stream.acceptDurable({
    type: "event",
    event: {
      type: "step/end",
      seq: SessionSeq(origin + 3),
      time: texts.length + 4,
      data: { turn, step },
    },
  });
  if (closed?.type !== "publish" || closed.retireAttemptId !== attemptId) {
    throw new Error("Expected the completed step to retire the live attempt");
  }
  assembler.append(closed.entry);
  assembler.settleAssistant(closed.retireAttemptId);
  expect(reply()).toMatchObject({ text: expected, status: "settled" });
});

describe("UiConversation live-chunk coalescing and hidden-window deferral", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as { __codexhostWindowHidden?: unknown }).__codexhostWindowHidden;
  });

  function createConversationHarness() {
    const ctx = new Context();
    const sessionCtx = ctx.extend();
    const sessionId = SessionId("stream-session");
    const eventSource = new MutableSessionEventSource();
    const binding = {
      sessionId,
      ctx: sessionCtx,
      eventSource,
    } as unknown as SessionBinding;
    const sessions = {
      binding: (id: SessionId) => (id === sessionId ? binding : undefined),
    } as unknown as ISessions;
    const uiConversation = new UiConversation(ctx, sessions);
    uiConversation.events.register(assistantDefinition);
    uiConversation.views.register(chatViewDefinition);
    const conversation = uiConversation.binding(binding);
    const chatSource = conversation.target("chat");
    const notifications = vi.fn();
    const unsubscribe = chatSource.subscribe(notifications);

    const stream = new ClientAssistantStream();
    const turn = 1;
    const step = 1;
    const attemptId = LlmAttemptId("coalesce-attempt");
    const initial: SessionLiveEventEntry[] = [
      {
        type: "event",
        event: { type: "turn/start", seq: SessionSeq(1), time: 1, data: { turn } },
      },
      {
        type: "event",
        event: { type: "step/start", seq: SessionSeq(2), time: 2, data: { turn, step } },
      },
    ];
    eventSource.replace(stream.replace(initial), false);
    stream.acceptFrame({
      type: "start",
      revision: 1,
      attemptId,
      startedAfterSeq: SessionSeq(2),
      turn,
      step,
    });
    notifications.mockClear();

    let chunkIndex = 0;
    const pushChunk = (text: string) => {
      const result = stream.acceptFrame({
        type: "chunk",
        revision: chunkIndex + 2,
        attemptId,
        index: chunkIndex,
        time: 10 + chunkIndex,
        chunk: { type: "text-delta", index: 0, text },
      });
      chunkIndex += 1;
      if (result?.type !== "transient") throw new Error("expected transient chunk");
      eventSource.append(result.entry);
    };

    const currentReply = () => {
      const chat = chatSource.getSnapshot();
      const node = chat?.nodes.values().find((item) => item.kind === "assistant-step") as
        ChatNode<"assistant-step"> | undefined;
      if (!node) return undefined;
      return {
        status: node.data.status,
        text: node.data.blocks
          .flatMap((block) => (block.kind === "text" ? [block.text] : []))
          .join(""),
      };
    };

    return {
      ctx,
      eventSource,
      stream,
      attemptId,
      turn,
      step,
      notifications,
      pushChunk,
      currentReply,
      get chunkCount() {
        return chunkIndex;
      },
      async dispose() {
        unsubscribe();
        await ctx.fiber.dispose();
      },
    };
  }

  it("coalesces bursts of live chunks within the time window and flushes immediately on settlement", async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      if (id >= 1 && id <= frames.length) frames[id - 1] = () => {};
    });

    const h = createConversationHarness();
    try {
      h.pushChunk("Hello");
      h.pushChunk(", ");
      h.pushChunk("world");

      // Nothing published yet while within the coalescing window.
      expect(h.notifications).not.toHaveBeenCalled();
      expect(h.currentReply()).toBeUndefined();

      vi.advanceTimersByTime(LIVE_STREAM_COALESCE_MS - 1);
      expect(h.notifications).not.toHaveBeenCalled();

      // At LIVE_STREAM_COALESCE_MS, a single paint-aligned rAF flushes the entire burst once.
      vi.advanceTimersByTime(1);
      expect(frames).toHaveLength(1);
      expect(h.notifications).not.toHaveBeenCalled();
      frames.shift()!(16);
      expect(h.notifications).toHaveBeenCalledTimes(1);
      expect(h.currentReply()).toEqual({ status: "running", text: "Hello, world" });

      // A subsequent burst followed immediately by a durable settlement flushes synchronously
      // without waiting for the coalescing timer or rAF.
      h.pushChunk("!");
      expect(h.notifications).toHaveBeenCalledTimes(1);

      const messageSeq = SessionSeq(3);
      h.stream.acceptDurable({
        type: "event",
        event: {
          type: "assistant/message",
          seq: messageSeq,
          time: 100,
          surfaceOp: "append",
          data: {
            turn: h.turn,
            step: h.step,
            stream: [],
            message: {
              id: MessageId("settled-reply"),
              role: "assistant",
              source: { kind: "model", provider: "test", model: "test" },
              content: [{ type: "text", text: "Hello, world!" }],
            },
          },
        },
      });
      const settled = h.stream.acceptFrame({
        type: "end",
        revision: h.chunkCount + 2,
        attemptId: h.attemptId,
        index: h.chunkCount,
        outcome: { kind: "committed", eventType: "assistant/message", seq: messageSeq },
      });
      if (settled?.type !== "publish") throw new Error("expected publish settlement");
      h.eventSource.append(settled.entry);

      expect(h.notifications).toHaveBeenCalledTimes(2);
      expect(h.currentReply()).toEqual({ status: "settled", text: "Hello, world!" });

      // Cancelled pending timer must not trigger an extra redundant notification later.
      vi.advanceTimersByTime(LIVE_STREAM_COALESCE_MS * 3);
      expect(h.notifications).toHaveBeenCalledTimes(2);
    } finally {
      await h.dispose();
    }
  });

  it("defers live-chunk notifications while hidden, flushes on visibility resume, and cleans up listeners on dispose", async () => {
    vi.useFakeTimers();
    let docHidden = true;
    const docListeners = new Set<() => void>();
    const winListeners = new Set<(event: Event) => void>();
    const fakeWindow: {
      __codexhostWindowHidden: boolean;
      addEventListener: (type: string, listener: (event: Event) => void) => void;
      removeEventListener: (type: string, listener: (event: Event) => void) => void;
    } = {
      __codexhostWindowHidden: false,
      addEventListener: (type, listener) => {
        if (type === "codexhost:window-hidden-change") winListeners.add(listener);
      },
      removeEventListener: (type, listener) => {
        if (type === "codexhost:window-hidden-change") winListeners.delete(listener);
      },
    };
    vi.stubGlobal("document", {
      get hidden() {
        return docHidden;
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") docListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") docListeners.delete(listener);
      },
    });
    vi.stubGlobal("window", fakeWindow);

    const h = createConversationHarness();
    try {
      // Hidden via document.hidden: chunks accumulate silently with zero React notifications.
      h.pushChunk("part-1 ");
      h.pushChunk("part-2");
      vi.advanceTimersByTime(5_000);
      expect(h.notifications).not.toHaveBeenCalled();
      expect(docListeners.size).toBe(1);
      expect(winListeners.size).toBe(1);

      // Resuming visibility flushes all accumulated chunks immediately and detaches listeners.
      docHidden = false;
      for (const listener of [...docListeners]) listener();
      expect(h.notifications).toHaveBeenCalledTimes(1);
      expect(h.currentReply()).toEqual({ status: "running", text: "part-1 part-2" });
      expect(docListeners.size).toBe(0);
      expect(winListeners.size).toBe(0);

      // Hidden via desktop shell flag (__codexhostWindowHidden): defers until shell resume event.
      fakeWindow.__codexhostWindowHidden = true;
      (globalThis as { __codexhostWindowHidden?: boolean }).__codexhostWindowHidden = true;
      h.pushChunk(" part-3");
      vi.advanceTimersByTime(5_000);
      expect(h.notifications).toHaveBeenCalledTimes(1);
      expect(winListeners.size).toBe(1);

      fakeWindow.__codexhostWindowHidden = false;
      (globalThis as { __codexhostWindowHidden?: boolean }).__codexhostWindowHidden = false;
      for (const listener of [...winListeners]) {
        listener({ detail: { hidden: false } } as unknown as Event);
      }
      expect(h.notifications).toHaveBeenCalledTimes(2);
      expect(h.currentReply()).toEqual({ status: "running", text: "part-1 part-2 part-3" });
      expect(docListeners.size).toBe(0);
      expect(winListeners.size).toBe(0);

      // Disposing while hidden removes any attached visibility listeners cleanly.
      docHidden = true;
      h.pushChunk(" part-4");
      expect(docListeners.size).toBe(1);
      expect(winListeners.size).toBe(1);
    } finally {
      await h.dispose();
    }
    expect(docListeners.size).toBe(0);
    expect(winListeners.size).toBe(0);
  });

  it("defers a mid-flight 40ms/rAF flush if the window hides before paint and ignores callbacks after dispose", async () => {
    vi.useFakeTimers();
    let docHidden = false;
    const docListeners = new Set<() => void>();
    const winListeners = new Set<(event: Event) => void>();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    // Deliberately leave already-queued callbacks callable to verify the disposed guard too.
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("document", {
      get hidden() {
        return docHidden;
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") docListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") docListeners.delete(listener);
      },
    });
    vi.stubGlobal("window", {
      __codexhostWindowHidden: false,
      addEventListener: (type: string, listener: (event: Event) => void) => {
        if (type === "codexhost:window-hidden-change") winListeners.add(listener);
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        if (type === "codexhost:window-hidden-change") winListeners.delete(listener);
      },
    });

    const h = createConversationHarness();
    try {
      // Case 1: window hides while the 40ms timer is pending -> timer transitions to hidden deferral.
      h.pushChunk("alpha");
      docHidden = true;
      vi.advanceTimersByTime(LIVE_STREAM_COALESCE_MS);
      expect(h.notifications).not.toHaveBeenCalled();
      expect(frames).toHaveLength(0);
      expect(docListeners.size).toBe(1);

      docHidden = false;
      for (const listener of [...docListeners]) listener();
      expect(h.notifications).toHaveBeenCalledTimes(1);
      expect(h.currentReply()).toEqual({ status: "running", text: "alpha" });

      // Case 2: window hides after timer fired while rAF is pending -> rAF defers instead of flushing.
      h.pushChunk(" beta");
      vi.advanceTimersByTime(LIVE_STREAM_COALESCE_MS);
      expect(frames).toHaveLength(1);
      docHidden = true;
      frames.shift()!(16);
      expect(h.notifications).toHaveBeenCalledTimes(1);
      expect(docListeners.size).toBe(1);

      docHidden = false;
      for (const listener of [...docListeners]) listener();
      expect(h.notifications).toHaveBeenCalledTimes(2);
      expect(h.currentReply()).toEqual({ status: "running", text: "alpha beta" });

      // Case 3: dispose while an rAF callback is queued -> late callback neither flushes nor attaches listeners.
      h.pushChunk(" gamma");
      vi.advanceTimersByTime(LIVE_STREAM_COALESCE_MS);
      expect(frames).toHaveLength(1);
      const staleFrame = frames.shift()!;
      await h.dispose();
      docHidden = true;
      staleFrame(32);
      expect(h.notifications).toHaveBeenCalledTimes(2);
      expect(docListeners.size).toBe(0);
      expect(winListeners.size).toBe(0);
    } finally {
      await h.dispose();
    }
  });
});
