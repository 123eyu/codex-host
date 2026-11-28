import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CodeBlockFoldMemoryProvider,
  JsonBlock,
  useCodeBlockFoldMemory,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {
  ConversationLocationDataStore,
  ConversationTurnDataMap,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {
  ChatNodeHookContext,
  ChatNodeOwnerProps,
  ChatViewSlotProps,
  UsePresentation,
} from "../contract/slots.ts";
import type { ChatNode } from "../contract/chat-nodes.ts";
import type { ChatNodeStore } from "../contract/snapshot.ts";
import {
  TURN_PROCESS_INDEPENDENT_KINDS,
  isIndependentProcessTool,
  turnProcessAlwaysOpen,
} from "../contract/turn-process.ts";
import { storedTurnProcessEntry } from "../stores.ts";
import { useNearViewport } from "./near-viewport.ts";
import { useSearchableHidden } from "./searchable-hidden.ts";
import { useTurnAnnotations } from "./turn-annotations.ts";
import css from "./ChatView.module.css";

interface ChatNodeSeatProps extends Omit<ChatNodeOwnerProps, "responseAnnotations"> {
  readonly nodeKey: string;
  /** A replaced Builder must rebind keyed hooks even when references and keys survive. */
  readonly nodeStore: ChatNodeStore;
  readonly useChatNode: ChatViewSlotProps["useChatNode"];
  readonly useChatNodeProcess: ChatViewSlotProps["useChatNodeProcess"];
  readonly usePresentation: UsePresentation;
  readonly useStore: ChatViewSlotProps["useStore"];
  readonly actions: ChatViewSlotProps["actions"];
  readonly renderSlot: ChatViewSlotProps["renderSlot"];
  readonly t: ChatViewSlotProps["t"];
  /** Whether this row's slot content should be mounted. Nested group members stay mounted. */
  readonly mounted?: boolean;
  /** Reserved height (px) while unmounted; ignored for hidden or zero-height seats. */
  readonly placeholderHeight?: number;
  /** Registers this top-level row shell with the transcript virtualizer. */
  readonly registerRow?: (flowKey: string, element: HTMLDivElement | null) => void;
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode["kind"]]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> };
}[ChatNode["kind"]];

function turnDataOf(
  node: ChatNode | undefined,
): ConversationLocationDataStore<ConversationTurnDataMap> | undefined {
  const location = node?.location;
  return location?.kind === "turn" || location?.kind === "step" ? location.turn.data : undefined;
}

function turnOf(node: ChatNode | undefined): number | undefined {
  const location = node?.location;
  return location?.kind === "turn" || location?.kind === "step" ? location.turn.turn : undefined;
}

/** File diffs and compaction stay visible; ordinary tools fold into work details. */
function isIndependentProcessToolNode(node: ChatNode | undefined): boolean {
  return node?.kind === "tool-call" && isIndependentProcessTool(node.data.root.name);
}

const CHAT_NODE_SLOT_NAME = "conversation.chat.node";
const CHAT_EMPTY_ATTRIBUTE = "data-chat-empty";
const SEAT_OBSERVER_COMPACT_MIN_OBSERVED = 64;

function seatSlotOf(wrapper: Element): Element | null {
  for (let child = wrapper.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.getAttribute("data-slot") === CHAT_NODE_SLOT_NAME) return child;
  }
  return null;
}

function isElementEmpty(element: Element): boolean {
  for (let node = element.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === Node.ELEMENT_NODE) return false;
    if (
      (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) &&
      (node.nodeValue?.length ?? 0) > 0
    ) {
      return false;
    }
  }
  return true;
}

function syncSeatEmptyAttribute(wrapper: HTMLElement, slot: Element | null): void {
  const empty = slot !== null && isElementEmpty(slot);
  if (empty) {
    if (!wrapper.hasAttribute(CHAT_EMPTY_ATTRIBUTE)) {
      wrapper.setAttribute(CHAT_EMPTY_ATTRIBUTE, "");
    }
  } else if (wrapper.hasAttribute(CHAT_EMPTY_ATTRIBUTE)) {
    wrapper.removeAttribute(CHAT_EMPTY_ATTRIBUTE);
  }
}

interface SeatEmptyCoordinator {
  observe(wrapper: HTMLElement): void;
  unobserve(wrapper: HTMLElement): void;
}

const seatEmptyCoordinators = new WeakMap<Document, SeatEmptyCoordinator>();

/**
 * Share a single direct-child MutationObserver per document across all mounted
 * `ChatNodeSeat` shells so empty-slot tracking never spawns one observer per row
 * or runs synchronous DOM checks on unrelated React re-renders.
 */
function seatEmptyCoordinatorFor(doc: Document): SeatEmptyCoordinator | null {
  if (typeof MutationObserver === "undefined") return null;
  const existing = seatEmptyCoordinators.get(doc);
  if (existing !== undefined) return existing;

  const activeSeats = new Map<HTMLElement, Element | null>();
  const slotToWrapper = new WeakMap<Element, HTMLElement>();
  let observedNodes = new WeakSet<Node>();
  let observedCount = 0;

  const observeNode = (obs: MutationObserver, node: Node): void => {
    if (observedNodes.has(node)) return;
    obs.observe(node, { childList: true });
    observedNodes.add(node);
    observedCount += 1;
  };

  let observer!: MutationObserver;

  const processRecords = (records: readonly MutationRecord[]): void => {
    const dirtyWrappers = new Set<HTMLElement>();
    const wrapperChanged = new Set<HTMLElement>();
    for (const record of records) {
      const target = record.target;
      if (activeSeats.has(target as HTMLElement)) {
        const wrapper = target as HTMLElement;
        dirtyWrappers.add(wrapper);
        wrapperChanged.add(wrapper);
      } else if (target.nodeType === 1) {
        const wrapper = slotToWrapper.get(target as Element);
        if (wrapper !== undefined && activeSeats.has(wrapper)) {
          dirtyWrappers.add(wrapper);
        }
      }
    }
    for (const wrapper of dirtyWrappers) {
      let slot = activeSeats.get(wrapper) ?? null;
      if (wrapperChanged.has(wrapper)) {
        const nextSlot = seatSlotOf(wrapper);
        if (nextSlot !== slot) {
          if (slot !== null) slotToWrapper.delete(slot);
          activeSeats.set(wrapper, nextSlot);
          if (nextSlot !== null) {
            slotToWrapper.set(nextSlot, wrapper);
            observeNode(observer, nextSlot);
          }
          slot = nextSlot;
        }
      }
      syncSeatEmptyAttribute(wrapper, slot);
    }
  };

  observer = new MutationObserver(processRecords);

  const compact = (): void => {
    const pending = observer.takeRecords();
    if (pending.length > 0) {
      processRecords(pending);
    }
    observer.disconnect();
    observedNodes = new WeakSet<Node>();
    observedCount = 0;
    for (const [wrapper, prevSlot] of activeSeats) {
      const nextSlot = seatSlotOf(wrapper);
      if (nextSlot !== prevSlot) {
        if (prevSlot !== null) slotToWrapper.delete(prevSlot);
        activeSeats.set(wrapper, nextSlot);
      }
      observeNode(observer, wrapper);
      if (nextSlot !== null) {
        slotToWrapper.set(nextSlot, wrapper);
        observeNode(observer, nextSlot);
      }
      syncSeatEmptyAttribute(wrapper, nextSlot);
    }
  };

  const coordinator: SeatEmptyCoordinator = {
    observe(wrapper) {
      const prevSlot = activeSeats.get(wrapper);
      const slot = seatSlotOf(wrapper);
      if (prevSlot !== undefined && prevSlot !== null && prevSlot !== slot) {
        slotToWrapper.delete(prevSlot);
      }
      activeSeats.set(wrapper, slot);
      observeNode(observer, wrapper);
      if (slot !== null) {
        slotToWrapper.set(slot, wrapper);
        observeNode(observer, slot);
      }
      syncSeatEmptyAttribute(wrapper, slot);
    },
    unobserve(wrapper) {
      if (!activeSeats.has(wrapper)) return;
      const prevSlot = activeSeats.get(wrapper);
      if (prevSlot !== undefined && prevSlot !== null) {
        slotToWrapper.delete(prevSlot);
      }
      activeSeats.delete(wrapper);
      if (activeSeats.size === 0) {
        observer.disconnect();
        observedNodes = new WeakSet<Node>();
        observedCount = 0;
      } else if (
        observedCount > Math.max(SEAT_OBSERVER_COMPACT_MIN_OBSERVED, activeSeats.size * 4)
      ) {
        compact();
      }
    },
  };

  seatEmptyCoordinators.set(doc, coordinator);
  return coordinator;
}

/**
 * Subscribe, apply Turn-process visibility, and dispatch one stable Context key.
 * Policy reads select this seat's own conclusion, so a mode change re-renders
 * only seats whose visibility actually changes.
 */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey,
  groupPart,
  nodeStore,
  useChatNode,
  useChatNodeProcess,
  usePresentation,
  cwd,
  openFile,
  openSkill,
  inspectCall,
  forkAt,
  handoffAt,
  loadTurnDiffs,
  messageEditing,
  loadImage,
  renderMessageImages,
  fileMentions,
  useStore,
  actions,
  renderSlot,
  t,
  mounted = true,
  placeholderHeight,
  registerRow,
}: ChatNodeSeatProps) {
  const node = useChatNode(nodeKey);
  const routedNode = node as ChatNode | undefined;
  const turn = turnOf(routedNode);
  const processPresentation = useChatNodeProcess(nodeKey);
  const processSpec = processPresentation?.spec;
  const storedEntry = useStore((state) =>
    processSpec === undefined ? undefined : storedTurnProcessEntry(state, processSpec.turn),
  );
  const processEntry =
    processSpec !== undefined && storedEntry?.answerStep === (processSpec.answerStep ?? 0)
      ? storedEntry
      : undefined;
  const liveProcess = processPresentation !== undefined && !processPresentation.turnClosed;
  const interleavedInput = processPresentation?.hasInterleavedInput === true;
  const alwaysOpen = liveProcess || interleavedInput || turnProcessAlwaysOpen(routedNode);
  const processOpen = alwaysOpen || processEntry !== undefined;
  const setOpen = useCallback(
    (open: boolean) => {
      if (processSpec !== undefined && !alwaysOpen) {
        actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep ?? 0, open);
      }
    },
    [actions, processSpec, alwaysOpen],
  );
  const foldCompleted = usePresentation((policy) => policy.foldCompletedTurns);
  // A loaded end makes a partial historical Turn eligible without its start.
  const processWindowReady =
    processSpec !== undefined &&
    processPresentation !== undefined &&
    foldCompleted &&
    processPresentation.turn === processSpec.turn &&
    (processPresentation.turnStarted || processPresentation.turnClosed);
  const processAnswer =
    routedNode !== undefined &&
    processWindowReady &&
    !liveProcess &&
    groupPart !== "reasoning" &&
    routedNode.kind === "assistant-step" &&
    routedNode.data.step === processSpec.answerStep;
  // Live rows retain their first-token anchor, not their later settlement seq.
  const processMember =
    routedNode !== undefined &&
    processWindowReady &&
    !processAnswer &&
    !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind) &&
    !isIndependentProcessToolNode(routedNode) &&
    routedNode.anchorSeq >= processSpec.processStartSeq;
  const ownsDisclosure = routedNode?.kind === "turn-process" || processAnswer;
  const foldable = processWindowReady && (liveProcess || processMember || ownsDisclosure);
  const turnProcess = useMemo(
    () =>
      processSpec === undefined
        ? undefined
        : {
            spec: processSpec,
            foldable,
            hasContent:
              !interleavedInput &&
              (processPresentation?.hasExternalProcess === true || processSpec.inlineReasoning),
            open: processOpen,
            setOpen,
          },
    [
      foldable,
      interleavedInput,
      processOpen,
      processSpec,
      processPresentation?.hasExternalProcess,
      setOpen,
    ],
  );
  const controllerInactive = routedNode?.kind === "turn-process" && foldCompleted && !foldable;
  const compactAnswer =
    processAnswer && foldable && processPresentation.compactAnswer && !processOpen;
  const processHidden = controllerInactive || (foldable && processMember && !processOpen);
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true);
  }, [processMember, setOpen]);
  const wrapperRef = useSearchableHidden(processHidden, revealProcess);
  useNearViewport(wrapperRef, node !== undefined);
  const flowKey =
    routedNode === undefined
      ? undefined
      : groupPart === undefined || groupPart === "response"
        ? routedNode.key
        : JSON.stringify([routedNode.key, groupPart]);
  const hasRow = routedNode !== undefined && flowKey !== undefined;
  const nodeKind = routedNode?.kind;
  // Reflect an empty direct `conversation.chat.node` slot onto the row shell so CSS
  // can collapse empty seats without `:has()` sibling selectors inside container queries.
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (element === null) return;
    if (!mounted || !hasRow) {
      if (element.hasAttribute(CHAT_EMPTY_ATTRIBUTE)) {
        element.removeAttribute(CHAT_EMPTY_ATTRIBUTE);
      }
      return;
    }
    const coordinator = seatEmptyCoordinatorFor(element.ownerDocument);
    if (coordinator === null) {
      syncSeatEmptyAttribute(element, seatSlotOf(element));
      return;
    }
    coordinator.observe(element);
    return () => {
      coordinator.unobserve(element);
    };
  }, [mounted, hasRow, flowKey, nodeKind, wrapperRef]);
  useLayoutEffect(() => {
    if (registerRow === undefined || flowKey === undefined) return;
    const element = wrapperRef.current;
    if (element === null) return;
    registerRow(flowKey, element);
    return () => {
      registerRow(flowKey, null);
    };
  }, [registerRow, flowKey, wrapperRef]);
  const [disclosureReset] = useState(() => createSnapshotStore(0));
  const inheritedFoldMemory = useCodeBlockFoldMemory();
  const ownFoldMemoryRef = useRef<Map<string, boolean> | null>(null);
  if (inheritedFoldMemory === undefined && ownFoldMemoryRef.current === null) {
    ownFoldMemoryRef.current = new Map();
  }
  const foldMemory = inheritedFoldMemory ?? ownFoldMemoryRef.current!;
  // A reply resolves its annotation citations against the message it answers.
  const responseAnnotations = useTurnAnnotations(nodeStore, turn);
  const turnData = turnDataOf(routedNode);
  const hookContext = useMemo<ChatNodeHookContext>(
    () => ({ turnData, disclosureReset }),
    [turnData, disclosureReset],
  );
  useEffect(() => {
    if (processMember && processHidden && wrapperRef.current?.hasAttribute("hidden")) {
      disclosureReset.set(disclosureReset.getSnapshot() + 1);
    }
  }, [processMember, processHidden, wrapperRef, disclosureReset]);
  const owner = useMemo<ChatNodeOwnerProps | null>(
    () =>
      node === undefined
        ? null
        : {
            ...(groupPart === undefined ? {} : { groupPart }),
            cwd,
            openFile,
            openSkill,
            inspectCall,
            forkAt,
            handoffAt,
            loadTurnDiffs,
            messageEditing,
            loadImage,
            renderMessageImages,
            fileMentions,
            turnProcess,
            responseAnnotations,
          },
    [
      node,
      groupPart,
      cwd,
      openFile,
      openSkill,
      inspectCall,
      forkAt,
      handoffAt,
      loadTurnDiffs,
      messageEditing,
      loadImage,
      renderMessageImages,
      fileMentions,
      turnProcess,
      responseAnnotations,
    ],
  );
  if (routedNode === undefined || owner === null || flowKey === undefined) return null;
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner;
  const virtualizedPlaceholder =
    !mounted && !processHidden && placeholderHeight !== undefined && placeholderHeight > 0;
  return (
    <div
      ref={wrapperRef}
      className={css.flowItem}
      data-chat-anchor-key={flowKey}
      data-chat-flow-key={flowKey}
      data-chat-paging-anchor={routedNode.kind !== "turn-process" || undefined}
      data-chat-node-key={routedNode.key}
      data-chat-group-part={groupPart}
      data-chat-flow-kind={routedNode.kind}
      data-chat-turn={turn}
      data-turn-process-member={processMember || undefined}
      data-turn-process-hidden={processHidden || undefined}
      data-turn-process-answer={compactAnswer || undefined}
      data-chat-virtualized={virtualizedPlaceholder ? "" : undefined}
      style={virtualizedPlaceholder ? { minHeight: placeholderHeight } : undefined}
    >
      {mounted ? (
        <CodeBlockFoldMemoryProvider memory={foldMemory} scope={flowKey}>
          {renderSlot("conversation.chat.node", routedOwner, {
            entryKey: routedNode.kind,
            hookContext,
            fallback: (
              <JsonBlock
                label={t("message.unknownSurface", { type: routedNode.kind })}
                payload={routedNode.data}
                truncatedLabel={(total) => t("json.truncated", { total })}
              />
            ),
          })}
        </CodeBlockFoldMemoryProvider>
      ) : null}
    </div>
  );
});
