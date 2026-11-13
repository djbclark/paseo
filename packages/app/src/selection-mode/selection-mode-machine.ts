import { SELECTION_MODE_KEY } from "./constants";

export type SelectionModeState = "off" | "held" | "latched";

export interface KeyModifiers {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
}

/**
 * `hasSelection` means a selection made while Shift was held still exists. The caller owns that
 * definition; the machine only needs to know whether text is worth keeping selectable.
 */
export type SelectionModeEvent =
  | {
      type: "keydown";
      key: string;
      shiftKey: boolean;
      mods: KeyModifiers;
      editableTarget: boolean;
      hasSelection: boolean;
    }
  | { type: "keyup"; key: string; hasSelection: boolean }
  | { type: "pointermove"; shiftKey: boolean; hasSelection: boolean }
  | { type: "selectionchange"; collapsed: boolean }
  | { type: "blur" }
  | { type: "hidden" };

export function isActive(state: SelectionModeState): boolean {
  return state !== "off";
}

// Chromium drops user-select:none text from Selection.toString() and from copies, so a selection
// made in the mode needs the mode's stylesheet to stay on until it collapses.
function leaveHeld(hasSelection: boolean): SelectionModeState {
  return hasSelection ? "latched" : "off";
}

export function reduceSelectionMode(
  state: SelectionModeState,
  event: SelectionModeEvent,
): SelectionModeState {
  switch (event.type) {
    case "keydown":
      return reduceKeydown(state, event);
    case "keyup":
      return state === "held" && event.key === SELECTION_MODE_KEY
        ? leaveHeld(event.hasSelection)
        : state;
    case "pointermove":
      return state === "held" && !event.shiftKey ? leaveHeld(event.hasSelection) : state;
    case "selectionchange":
      return state === "latched" && event.collapsed ? "off" : state;
    case "blur":
    case "hidden":
      return "off";
  }
}

function reduceKeydown(
  state: SelectionModeState,
  event: Extract<SelectionModeEvent, { type: "keydown" }>,
): SelectionModeState {
  const isModeKey = event.key === SELECTION_MODE_KEY;
  if (state === "held") {
    return isModeKey && event.shiftKey ? "held" : leaveHeld(event.hasSelection);
  }
  const hasOtherModifier = event.mods.meta || event.mods.ctrl || event.mods.alt;
  if (!isModeKey || hasOtherModifier || event.editableTarget) {
    return state;
  }
  return "held";
}
