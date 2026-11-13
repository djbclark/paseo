import { SELECTION_MODE_KEY } from "./constants";

export type SelectionModeState = "off" | "held" | "latched";

export interface KeyModifiers {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
}

export type SelectionModeEvent =
  | {
      type: "keydown";
      key: string;
      shiftKey: boolean;
      mods: KeyModifiers;
      editableTarget: boolean;
    }
  | { type: "keyup"; key: string; selectionCollapsed: boolean }
  | { type: "pointermove"; shiftKey: boolean }
  | { type: "selectionchange"; collapsed: boolean }
  | { type: "blur" }
  | { type: "hidden" };

export function isActive(state: SelectionModeState): boolean {
  return state !== "off";
}

export function reduceSelectionMode(
  state: SelectionModeState,
  event: SelectionModeEvent,
): SelectionModeState {
  switch (event.type) {
    case "keydown":
      return reduceKeydown(state, event);
    case "keyup":
      return reduceKeyup(state, event);
    case "pointermove":
      return state === "held" && !event.shiftKey ? "off" : state;
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
  if (state === "held" && !event.shiftKey) {
    return "off";
  }
  if (event.key !== SELECTION_MODE_KEY) {
    return state === "held" ? "off" : state;
  }
  if (state !== "off") {
    return state;
  }
  const hasOtherModifier = event.mods.meta || event.mods.ctrl || event.mods.alt;
  return hasOtherModifier || event.editableTarget ? "off" : "held";
}

function reduceKeyup(
  state: SelectionModeState,
  event: Extract<SelectionModeEvent, { type: "keyup" }>,
): SelectionModeState {
  if (event.key !== SELECTION_MODE_KEY || state === "off") {
    return state;
  }
  return event.selectionCollapsed ? "off" : "latched";
}
