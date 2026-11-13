import { SELECTION_MODE_ATTRIBUTE, SELECTION_MODE_KEY, SELECTION_MODE_STYLE_ID } from "./constants";
import {
  isActive,
  reduceSelectionMode,
  type SelectionModeEvent,
  type SelectionModeState,
} from "./selection-mode-machine";

const EDITABLE_TARGET_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="combobox"]',
  ".xterm",
  '[data-testid="terminal-surface"]',
  "webview",
  "iframe",
  ".cm-editor",
  '[data-testid="git-diff-canvas-root"]',
].join(",");

const ROOT = `html[${SELECTION_MODE_ATTRIBUTE}]`;
const STYLE_TEXT = `${ROOT} *, ${ROOT} *::before, ${ROOT} *::after {
  user-select: text !important;
  -webkit-user-select: text !important;
}
${ROOT} * {
  -webkit-app-region: no-drag !important;
}
${ROOT} {
  cursor: text;
}
`;

const GESTURE_STOP_EVENTS = ["pointerdown", "mousedown", "touchstart", "dblclick"] as const;
const CLICK_EVENTS = ["click", "auxclick"] as const;

let installed: (() => void) | null = null;

function eventOriginElement(event: Event): Element | null {
  const origin = event.composedPath()[0];
  if (origin instanceof Element) {
    return origin;
  }
  return origin instanceof Node ? origin.parentElement : null;
}

function isEditableEvent(event: Event): boolean {
  const element = eventOriginElement(event);
  return element !== null && element.closest(EDITABLE_TARGET_SELECTOR) !== null;
}

function isActiveElementEditable(): boolean {
  const active = document.activeElement;
  return active !== null && active.closest(EDITABLE_TARGET_SELECTOR) !== null;
}

function isSelectionCollapsed(): boolean {
  const selection = window.getSelection();
  return selection === null || selection.isCollapsed;
}

export function installSelectionMode(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }
  if (installed) {
    return installed;
  }

  const root = document.documentElement;
  const style = document.createElement("style");
  style.id = SELECTION_MODE_STYLE_ID;
  style.textContent = STYLE_TEXT;
  document.head.append(style);

  let state: SelectionModeState = "off";
  // Whether text was selected during the current Shift hold, so a Shift tap over an unrelated
  // selection does not latch the mode.
  let selectedDuringHold = false;
  // Set when a held pointerdown was blocked: the click that ends the gesture is swallowed even if
  // Shift was released before the button.
  let swallowNextClick = false;
  const controller = new AbortController();
  const capture = { capture: true, signal: controller.signal };
  const bubble = { signal: controller.signal };

  function hasSelection(): boolean {
    return selectedDuringHold && !isSelectionCollapsed();
  }

  function dispatch(event: SelectionModeEvent): void {
    const previous = state;
    state = reduceSelectionMode(previous, event);
    if (state === previous) {
      return;
    }
    if (state === "held") {
      selectedDuringHold = previous === "latched";
    }
    root.toggleAttribute(SELECTION_MODE_ATTRIBUTE, isActive(state));
  }

  function onKeyDown(event: KeyboardEvent): void {
    // A repeating Shift must not re-arm a cancelled press or move a latched mode to held.
    if (event.repeat && event.key === SELECTION_MODE_KEY) {
      return;
    }
    dispatch({
      type: "keydown",
      key: event.key,
      shiftKey: event.shiftKey,
      mods: { meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey },
      editableTarget: isActiveElementEditable(),
      hasSelection: hasSelection(),
    });
  }

  function onKeyUp(event: KeyboardEvent): void {
    dispatch({ type: "keyup", key: event.key, hasSelection: hasSelection() });
  }

  function onPointerMove(event: PointerEvent): void {
    if (state === "held") {
      dispatch({ type: "pointermove", shiftKey: event.shiftKey, hasSelection: hasSelection() });
    }
  }

  function onSelectionChange(): void {
    const collapsed = isSelectionCollapsed();
    if (state === "held" && !collapsed) {
      selectedDuringHold = true;
    }
    dispatch({ type: "selectionchange", collapsed });
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      dispatch({ type: "hidden" });
    }
  }

  function onGestureStart(event: Event): void {
    if (event.type === "pointerdown") {
      swallowNextClick = false;
    }
    if (state !== "held" || isEditableEvent(event)) {
      return;
    }
    event.stopPropagation();
    if (event instanceof PointerEvent && event.type === "pointerdown") {
      swallowNextClick = true;
      // Shift+press would otherwise extend an earlier caret or selection instead of starting here.
      if (event.button === 0) {
        window.getSelection()?.removeAllRanges();
      }
    }
  }

  function onClick(event: Event): void {
    if (isEditableEvent(event) || (state !== "held" && !swallowNextClick)) {
      return;
    }
    swallowNextClick = false;
    event.stopPropagation();
    event.preventDefault();
  }

  function onDragStart(event: Event): void {
    if (state !== "held" || isEditableEvent(event)) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
  }

  function onContextMenu(event: Event): void {
    if (isActive(state) && !isSelectionCollapsed() && !isEditableEvent(event)) {
      event.stopPropagation();
    }
  }

  window.addEventListener("keydown", onKeyDown, capture);
  window.addEventListener("keyup", onKeyUp, capture);
  window.addEventListener("pointermove", onPointerMove, capture);
  window.addEventListener("blur", () => dispatch({ type: "blur" }), bubble);
  document.addEventListener("selectionchange", onSelectionChange, bubble);
  document.addEventListener("visibilitychange", onVisibilityChange, bubble);
  for (const type of GESTURE_STOP_EVENTS) {
    document.addEventListener(type, onGestureStart, capture);
  }
  for (const type of CLICK_EVENTS) {
    document.addEventListener(type, onClick, capture);
  }
  document.addEventListener("dragstart", onDragStart, capture);
  document.addEventListener("contextmenu", onContextMenu, capture);

  installed = () => {
    controller.abort();
    root.removeAttribute(SELECTION_MODE_ATTRIBUTE);
    style.remove();
    installed = null;
  };
  return installed;
}
