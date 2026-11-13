import { describe, expect, it } from "vitest";
import {
  isActive,
  reduceSelectionMode,
  type KeyModifiers,
  type SelectionModeEvent,
  type SelectionModeState,
} from "./selection-mode-machine";

const NO_MODS: KeyModifiers = { meta: false, ctrl: false, alt: false };

function keydown(
  key: string,
  options: { mods?: Partial<KeyModifiers>; editableTarget?: boolean; shiftKey?: boolean } = {},
): SelectionModeEvent {
  return {
    type: "keydown",
    key,
    shiftKey: options.shiftKey ?? true,
    mods: { ...NO_MODS, ...options.mods },
    editableTarget: options.editableTarget ?? false,
  };
}

function keyup(key: string, selectionCollapsed: boolean): SelectionModeEvent {
  return { type: "keyup", key, selectionCollapsed };
}

function run(start: SelectionModeState, ...events: SelectionModeEvent[]): SelectionModeState {
  return events.reduce(reduceSelectionMode, start);
}

describe("selection mode: shift turns the mode on", () => {
  it("goes from off to held on a bare Shift keydown", () => {
    expect(run("off", keydown("Shift"))).toBe("held");
  });

  it("stays off when focus is in an editable target", () => {
    expect(run("off", keydown("Shift", { editableTarget: true }))).toBe("off");
  });

  it.each(["meta", "ctrl", "alt"] as const)("stays off when Shift arrives with %s down", (mod) => {
    expect(run("off", keydown("Shift", { mods: { [mod]: true } }))).toBe("off");
  });

  it("ignores other keys while off", () => {
    expect(run("off", keydown("a"), keyup("a", false))).toBe("off");
  });

  it("stays held on a repeated Shift keydown", () => {
    expect(run("off", keydown("Shift"), keydown("Shift"))).toBe("held");
  });
});

describe("selection mode: another key cancels the press", () => {
  it.each(["x", "A", "Meta", "Control", "Alt", "Tab"])(
    "turns off when %s goes down while Shift is held",
    (key) => {
      expect(run("off", keydown("Shift"), keydown(key))).toBe("off");
    },
  );

  it("stays off through Shift release after a cancelled press", () => {
    expect(
      run("off", keydown("Shift"), keydown("x"), keyup("x", true), keyup("Shift", false)),
    ).toBe("off");
  });

  it("does not turn a latched selection off when a key goes down", () => {
    expect(run("latched", keydown("c", { mods: { meta: true } }))).toBe("latched");
  });
});

describe("selection mode: releasing Shift", () => {
  it("latches when a selection exists", () => {
    expect(run("off", keydown("Shift"), keyup("Shift", false))).toBe("latched");
  });

  it("turns off when the selection is collapsed", () => {
    expect(run("off", keydown("Shift"), keyup("Shift", true))).toBe("off");
  });

  it("ignores the release of other keys while held", () => {
    expect(run("held", keyup("x", false))).toBe("held");
  });

  it("keeps a latched mode on when Shift is released over a selection", () => {
    expect(run("latched", keydown("Shift"), keyup("Shift", false))).toBe("latched");
  });

  it("turns a latched mode off when Shift is pressed again and released over no selection", () => {
    expect(run("latched", keydown("Shift"), keyup("Shift", true))).toBe("off");
  });
});

describe("selection mode: held, selection changes", () => {
  it("stays held while the selection collapses during a drag", () => {
    expect(run("held", { type: "selectionchange", collapsed: true })).toBe("held");
  });
});

describe("selection mode: latched mode turns off", () => {
  it("when the selection collapses", () => {
    expect(run("latched", { type: "selectionchange", collapsed: true })).toBe("off");
  });

  it("stays latched while the selection is non-collapsed", () => {
    expect(run("latched", { type: "selectionchange", collapsed: false })).toBe("latched");
  });

  it("not on Escape, which belongs to the app's interrupt shortcut", () => {
    expect(run("latched", keydown("Escape"))).toBe("latched");
  });

  it("on window blur", () => {
    expect(run("latched", { type: "blur" })).toBe("off");
  });

  it("when the page is hidden", () => {
    expect(run("latched", { type: "hidden" })).toBe("off");
  });
});

describe("selection mode: held mode turns off on interruptions", () => {
  it.each([{ type: "blur" }, { type: "hidden" }] as const)("on $type", (event) => {
    expect(run("held", event)).toBe("off");
  });
});

describe("selection mode: held, Shift released out of sight", () => {
  it("turns off on a pointermove without Shift", () => {
    expect(run("held", { type: "pointermove", shiftKey: false })).toBe("off");
  });

  it("stays held on a pointermove with Shift", () => {
    expect(run("held", { type: "pointermove", shiftKey: true })).toBe("held");
  });

  it("turns off on a keydown without Shift", () => {
    expect(run("held", keydown("Shift", { shiftKey: false }))).toBe("off");
  });

  it("leaves a latched mode alone on a pointermove without Shift", () => {
    expect(run("latched", { type: "pointermove", shiftKey: false })).toBe("latched");
  });

  it("leaves a latched mode alone on a keydown without Shift", () => {
    expect(run("latched", keydown("c", { shiftKey: false, mods: { meta: true } }))).toBe("latched");
  });
});

describe("selection mode: nothing happens while off", () => {
  it.each([
    { type: "selectionchange", collapsed: true },
    { type: "selectionchange", collapsed: false },
    { type: "blur" },
    { type: "hidden" },
    { type: "pointermove", shiftKey: false },
  ] as const)("$type leaves off as off", (event) => {
    expect(run("off", event)).toBe("off");
  });
});

describe("isActive", () => {
  it.each([
    ["off", false],
    ["held", true],
    ["latched", true],
  ] as const)("%s -> %s", (state, expected) => {
    expect(isActive(state)).toBe(expected);
  });
});
