import type { SelectionCopyFeedback } from "./install";

const MODE_ATTRIBUTE = "data-paseo-selection-copy";
const EXCLUDED = `:is(input, textarea, select, [contenteditable]:not([contenteditable="false"]),
  .xterm, .cm-editor, .monaco-editor, iframe, webview,
  [data-selection-copy-exclude], [data-testid="desktop-window-controls"])`;

interface SelectionGesture {
  x: number;
  y: number;
  moved: boolean;
}

function eligibleTarget(target: EventTarget | null): target is Element {
  return target instanceof Element && !target.closest(EXCLUDED);
}

function onlyShift(event: MouseEvent | KeyboardEvent): boolean {
  return event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/** Capture propagation, not the browser default: cancelling mousedown disables text selection. */
export function installSelectionCopy(feedback: SelectionCopyFeedback): () => void {
  const style = document.createElement("style");
  style.textContent = `
    html[${MODE_ATTRIBUTE}] body *:not(${EXCLUDED}):not(${EXCLUDED} *) {
      user-select: text !important;
      -webkit-user-select: text !important;
      -webkit-user-drag: none !important;
      -webkit-app-region: no-drag !important;
      cursor: text !important;
    }
  `;
  document.head.append(style);

  let shiftHeld = false;
  let gesture: SelectionGesture | null = null;
  let retainHighlight = false;
  let blockClick = false;
  let disposed = false;

  function updateMode() {
    document.documentElement.toggleAttribute(
      MODE_ATTRIBUTE,
      shiftHeld || gesture !== null || retainHighlight,
    );
  }

  function cancel() {
    shiftHeld = false;
    gesture = null;
    retainHighlight = false;
    updateMode();
  }

  function keyChanged(event: KeyboardEvent) {
    if (event.key === "Escape") {
      cancel();
      return;
    }
    shiftHeld = onlyShift(event);
    updateMode();
  }

  function begin(event: MouseEvent) {
    blockClick = false;
    retainHighlight = false;
    shiftHeld = onlyShift(event);
    const primarySelection = event.button === 0 && shiftHeld && eligibleTarget(event.target);
    if (!primarySelection) {
      gesture = null;
      updateMode();
      return;
    }
    // Shift normally extends the previous range. This gesture always starts at the mouse.
    window.getSelection()?.removeAllRanges();
    gesture = { x: event.clientX, y: event.clientY, moved: false };
    blockClick = true;
    updateMode();
    event.stopImmediatePropagation();
  }

  function pointerDown(event: PointerEvent) {
    if (event.pointerType === "mouse") begin(event);
  }

  function mouseDown(event: MouseEvent) {
    if (gesture) {
      event.stopImmediatePropagation();
      return;
    }
    begin(event);
  }

  function move(event: MouseEvent) {
    if (!gesture) return;
    const distance = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
    gesture.moved ||= distance >= 3;
    event.stopImmediatePropagation();
  }

  function pointerUp(event: PointerEvent) {
    if (gesture) event.stopImmediatePropagation();
  }

  function end(event: MouseEvent) {
    if (!gesture) return;
    const moved = gesture.moved;
    gesture = null;
    shiftHeld = onlyShift(event);
    event.stopImmediatePropagation();

    const selection = window.getSelection();
    retainHighlight = selection !== null && !selection.isCollapsed;
    updateMode();
    if (!moved || !selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    if (!eligibleTarget(event.target)) return;

    const range = selection.getRangeAt(0);
    if (!eligibleTarget(range.startContainer.parentElement)) return;
    if (!eligibleTarget(range.endContainer.parentElement)) return;
    for (const excluded of document.querySelectorAll(EXCLUDED)) {
      if (range.intersectsNode(excluded)) return;
    }
    const text = selection.toString();
    if (!text.trim()) return;

    // The Clipboard API leaves the DOM range intact and bypasses chat's rich-copy listener.
    void writeText(text).then(
      () => {
        if (!disposed) feedback.onCopied();
        return undefined;
      },
      () => {
        if (!disposed) feedback.onError();
      },
    );
  }

  function click(event: MouseEvent) {
    if (!blockClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    blockClick = false;
  }

  function dragStart(event: DragEvent) {
    if (!gesture) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function visibilityChanged() {
    if (document.hidden) cancel();
  }

  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  window.addEventListener("keydown", keyChanged, options);
  window.addEventListener("keyup", keyChanged, options);
  window.addEventListener("pointerdown", pointerDown, options);
  window.addEventListener("mousedown", mouseDown, options);
  window.addEventListener("pointermove", move, options);
  window.addEventListener("mousemove", move, options);
  window.addEventListener("pointerup", pointerUp, options);
  window.addEventListener("mouseup", end, options);
  window.addEventListener("click", click, options);
  window.addEventListener("dragstart", dragStart, options);
  window.addEventListener("pointercancel", cancel, options);
  window.addEventListener("blur", cancel, options);
  document.addEventListener("visibilitychange", visibilityChanged, options);

  return () => {
    disposed = true;
    listeners.abort();
    cancel();
    style.remove();
  };
}

async function writeText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
