import { describe, expect, it } from "vitest";
import type { SplitNode, SplitPane } from "@/stores/workspace-layout-store";
import { resolveProjectIconPaneId } from "./project-icon-pane";

function pane(id: string, hidden = false): SplitNode {
  return {
    kind: "pane",
    pane: {
      id,
      tabIds: [],
      focusedTabId: null,
      tabs: [],
      ...(hidden ? { hidden } : {}),
    } as SplitPane,
  };
}

function group(direction: "horizontal" | "vertical", children: SplitNode[]): SplitNode {
  return {
    kind: "group",
    group: {
      id: `group-${direction}`,
      direction,
      sizes: children.map(() => 1 / children.length),
      children,
    },
  };
}

describe("resolveProjectIconPaneId", () => {
  it("picks the only pane", () => {
    expect(resolveProjectIconPaneId(pane("solo"), null)).toBe("solo");
  });

  it("picks the left-most, top-most pane of a nested split", () => {
    const root = group("horizontal", [
      group("vertical", [pane("top-left"), pane("bottom-left")]),
      pane("right"),
    ]);
    expect(resolveProjectIconPaneId(root, null)).toBe("top-left");
  });

  it("skips hidden panes", () => {
    const root = group("horizontal", [pane("hidden-left", true), pane("right")]);
    expect(resolveProjectIconPaneId(root, null)).toBe("right");
  });

  it("gives the icon to the maximized pane even when it is not first", () => {
    const root = group("horizontal", [pane("left"), pane("right")]);
    expect(resolveProjectIconPaneId(root, "right")).toBe("right");
  });

  it("ignores a stale maximized pane id", () => {
    const root = group("horizontal", [pane("left"), pane("right")]);
    expect(resolveProjectIconPaneId(root, "gone")).toBe("left");
  });
});
