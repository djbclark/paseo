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

const POINTER_BLOCKER_EVENTS = [
  "pointerdown",
  "mousedown",
  "touchstart",
  "click",
  "auxclick",
  "dblclick",
  "dragstart",
] as const;

const DEFAULT_PREVENTED_EVENTS: ReadonlySet<string> = new Set(["click", "auxclick", "dragstart"]);

function isEditableElement(element: Element | null): boolean {
  return element !== null && element.closest(EDITABLE_TARGET_SELECTOR) !== null;
}

function isEditablePointerTarget(event: Event): boolean {
  const origin = event.composedPath()[0];
  return origin instanceof Element && isEditableElement(origin);
}

function isSelectionCollapsed(): boolean {
  const selection = window.getSelection();
  return selection === null || selection.isCollapsed;
}

function blockPointerEvent(event: Event): void {
  if (isEditablePointerTarget(event)) {
    return;
  }
  event.stopPropagation();
  if (DEFAULT_PREVENTED_EVENTS.has(event.type)) {
    event.preventDefault();
  }
}

function keydownToMachineEvent(event: KeyboardEvent): SelectionModeEvent {
  return {
    type: "keydown",
    key: event.key,
    shiftKey: event.shiftKey,
    mods: { meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey },
    editableTarget: isEditableElement(document.activeElement),
  };
}

export function installSelectionMode(): () => void {
  const root = document.documentElement;
  const existingStyle = document.getElementById(SELECTION_MODE_STYLE_ID);
  const style = existingStyle ?? document.createElement("style");
  if (!existingStyle) {
    style.id = SELECTION_MODE_STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.append(style);
  }

  let state: SelectionModeState = "off";

  function blockContextMenuOverSelection(event: Event): void {
    if (!isSelectionCollapsed()) {
      event.stopPropagation();
    }
  }

  function setPointerBlockers(enabled: boolean): void {
    for (const type of POINTER_BLOCKER_EVENTS) {
      if (enabled) {
        document.addEventListener(type, blockPointerEvent, true);
      } else {
        document.removeEventListener(type, blockPointerEvent, true);
      }
    }
  }

  function setActive(enabled: boolean): void {
    if (enabled) {
      root.setAttribute(SELECTION_MODE_ATTRIBUTE, "");
      document.addEventListener("contextmenu", blockContextMenuOverSelection, true);
      return;
    }
    root.removeAttribute(SELECTION_MODE_ATTRIBUTE);
    document.removeEventListener("contextmenu", blockContextMenuOverSelection, true);
  }

  function setPointerMoveWatch(enabled: boolean): void {
    if (enabled) {
      window.addEventListener("pointermove", onPointerMove, true);
    } else {
      window.removeEventListener("pointermove", onPointerMove, true);
    }
  }

  function dispatch(event: SelectionModeEvent): void {
    const previous = state;
    state = reduceSelectionMode(previous, event);
    if (state === previous) {
      return;
    }
    if (isActive(previous) !== isActive(state)) {
      setActive(isActive(state));
    }
    if ((previous === "held") !== (state === "held")) {
      setPointerBlockers(state === "held");
      setPointerMoveWatch(state === "held");
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat && event.key === SELECTION_MODE_KEY) {
      return;
    }
    dispatch(keydownToMachineEvent(event));
  }

  function onKeyUp(event: KeyboardEvent): void {
    dispatch({ type: "keyup", key: event.key, selectionCollapsed: isSelectionCollapsed() });
  }

  function onPointerMove(event: PointerEvent): void {
    dispatch({ type: "pointermove", shiftKey: event.shiftKey });
  }

  function onSelectionChange(): void {
    dispatch({ type: "selectionchange", collapsed: isSelectionCollapsed() });
  }

  function onBlur(): void {
    dispatch({ type: "blur" });
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      dispatch({ type: "hidden" });
    }
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    setActive(false);
    setPointerBlockers(false);
    setPointerMoveWatch(false);
    if (!existingStyle) {
      style.remove();
    }
  };
}
