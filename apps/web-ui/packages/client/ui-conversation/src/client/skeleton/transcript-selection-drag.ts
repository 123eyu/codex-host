/** Keeps a mouse text selection dragged from the transcript selecting past the composer. */

const SELECTION_DRAG = "data-selection-drag";

/**
 * Window events that end the press. Captured so a handler that stops
 * propagation cannot strand the mark. A native drag-and-drop must reach the
 * composer's drop targets, and a macOS Control-click may never deliver its
 * release once its context menu opens.
 */
const PRESS_ENDS = ["pointerup", "pointercancel", "dragstart", "contextmenu"] as const;

/**
 * Mark the scrollport while a primary mouse press that began in the transcript
 * is held. The composer seat is sticky inside the same scrollport, so the
 * drag reaches it without ever leaving the scrollport: WebKit then collapses
 * the page selection into the composer's editable and focuses it, and
 * selection autoscroll waits for the pointer to reach the window's bottom
 * edge. While the mark is set, CSS removes the seat's editable fields from
 * hit testing and pads the scrollport's end by the seat height, so the drag
 * keeps selecting the flow and the browser's own autoscroll starts at the
 * composer's top edge.
 * @param scroller - the conversation scrollport holding the transcript and the seat.
 * @returns a cleanup that detaches the listeners and clears the mark.
 */
export function trackTranscriptSelectionDrag(scroller: HTMLElement): () => void {
  const view = scroller.ownerDocument.defaultView;
  if (view === null) return () => {};
  const finish = (): void => {
    scroller.removeAttribute(SELECTION_DRAG);
    for (const type of PRESS_ENDS) view.removeEventListener(type, finish, true);
    // Bubble phase on the window: only the window's own blur, not an element's
    // (the press itself blurs a focused composer).
    view.removeEventListener("blur", finish);
  };
  const start = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null || target.closest("[data-composer-seat]") !== null) return;
    scroller.setAttribute(SELECTION_DRAG, "");
    for (const type of PRESS_ENDS) view.addEventListener(type, finish, true);
    view.addEventListener("blur", finish);
  };
  scroller.addEventListener("pointerdown", start, true);
  return () => {
    scroller.removeEventListener("pointerdown", start, true);
    finish();
  };
}
