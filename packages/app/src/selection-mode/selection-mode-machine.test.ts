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
  options: {
    mods?: Partial<KeyModifiers>;
    editableTarget?: boolean;
    shiftKey?: boolean;
    hasSelection?: boolean;
  } = {},
): SelectionModeEvent {
  return {
    type: "keydown",
    key,
    shiftKey: options.shiftKey ?? true,
    mods: { ...NO_MODS, ...options.mods },
    editableTarget: options.editableTarget ?? false,
    hasSelection: options.hasSelection ?? false,
  };
}

function keyup(key: string, hasSelection: boolean): SelectionModeEvent {
  return { type: "keyup", key, hasSelection };
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

describe("selection mode: another key ends the hold", () => {
  it.each(["x", "A", "Meta", "Control", "Alt", "Tab"])(
    "turns off when %s goes down over no selection",
    (key) => {
      expect(run("off", keydown("Shift"), keydown(key))).toBe("off");
    },
  );

  it.each(["x", "Meta", "Control"])("latches when %s goes down over a selection", (key) => {
    expect(run("off", keydown("Shift"), keydown(key, { hasSelection: true }))).toBe("latched");
  });

  it("stays off through Shift release after a cancelled press", () => {
    expect(
      run("off", keydown("Shift"), keydown("x"), keyup("x", false), keyup("Shift", false)),
    ).toBe("off");
  });

  it("does not turn a latched selection off when a key goes down", () => {
    expect(run("latched", keydown("c", { mods: { meta: true }, hasSelection: true }))).toBe(
      "latched",
    );
  });
});

describe("selection mode: releasing Shift", () => {
  it("latches when a selection was made", () => {
    expect(run("off", keydown("Shift"), keyup("Shift", true))).toBe("latched");
  });

  it("turns off when nothing was selected", () => {
    expect(run("off", keydown("Shift"), keyup("Shift", false))).toBe("off");
  });

  it("ignores the release of other keys while held", () => {
    expect(run("held", keyup("x", true))).toBe("held");
  });
});

describe("selection mode: Shift pressed while latched", () => {
  it("returns to held, so a second Shift-drag blocks clicks again", () => {
    expect(run("latched", keydown("Shift"))).toBe("held");
  });

  it("stays latched when Shift arrives with a modifier", () => {
    expect(run("latched", keydown("Shift", { mods: { meta: true } }))).toBe("latched");
  });

  it("stays latched when Shift arrives in an editable target", () => {
    expect(run("latched", keydown("Shift", { editableTarget: true }))).toBe("latched");
  });

  it("latches again on release over a selection", () => {
    expect(run("latched", keydown("Shift"), keyup("Shift", true))).toBe("latched");
  });

  it("turns off on release over no selection", () => {
    expect(run("latched", keydown("Shift"), keyup("Shift", false))).toBe("off");
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
    expect(run("latched", keydown("Escape", { shiftKey: false }))).toBe("latched");
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
  it("turns off on a pointermove without Shift over no selection", () => {
    expect(run("held", { type: "pointermove", shiftKey: false, hasSelection: false })).toBe("off");
  });

  it("latches on a pointermove without Shift over a selection", () => {
    expect(run("held", { type: "pointermove", shiftKey: false, hasSelection: true })).toBe(
      "latched",
    );
  });

  it("stays held on a pointermove with Shift", () => {
    expect(run("held", { type: "pointermove", shiftKey: true, hasSelection: true })).toBe("held");
  });

  it("turns off on a keydown without Shift over no selection", () => {
    expect(run("held", keydown("Shift", { shiftKey: false }))).toBe("off");
  });

  it("latches on a keydown without Shift over a selection", () => {
    expect(run("held", keydown("a", { shiftKey: false, hasSelection: true }))).toBe("latched");
  });

  it("leaves a latched mode alone on a pointermove without Shift", () => {
    expect(run("latched", { type: "pointermove", shiftKey: false, hasSelection: true })).toBe(
      "latched",
    );
  });
});

describe("selection mode: nothing happens while off", () => {
  it.each([
    { type: "selectionchange", collapsed: true },
    { type: "selectionchange", collapsed: false },
    { type: "blur" },
    { type: "hidden" },
    { type: "pointermove", shiftKey: false, hasSelection: true },
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
