import { describe, expect, it } from "vitest";
import {
  FOCUSED_PANE_PLACEMENT,
  closeTabInLayout,
  collectAllTabs,
  createDefaultLayout,
  moveTabToPaneInLayout,
  openTabInLayoutFocused,
  splitPaneInLayout,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { findClosedTabs } from "./tab-accent-prune";

function snapshot(layout: WorkspaceLayout) {
  return { layoutByWorkspace: { w: layout }, sheetsByWorkspace: {} };
}

function withTerminals(ids: string[]): { layout: WorkspaceLayout; tabIds: string[] } {
  let layout = createDefaultLayout();
  for (const terminalId of ids) {
    const opened = openTabInLayoutFocused({
      layout,
      target: { kind: "terminal", terminalId },
      now: 0,
      placement: FOCUSED_PANE_PLACEMENT,
      explorerSidebarPaneId: null,
    });
    if (!opened) throw new Error("open failed");
    layout = opened.layout;
  }
  return { layout, tabIds: collectAllTabs(layout.root).map((tab) => tab.tabId) };
}

describe("findClosedTabs", () => {
  it("reports a closed tab", () => {
    const { layout, tabIds } = withTerminals(["a", "b"]);
    const closed = closeTabInLayout({ layout, tabId: tabIds[0], explorerSidebarPaneId: null });
    if (!closed) throw new Error("close failed");
    expect(findClosedTabs(snapshot(layout), snapshot(closed)).closedTabs).toEqual({
      w: [tabIds[0]],
    });
  });

  it("does not report a tab dragged into another pane", () => {
    const { layout, tabIds } = withTerminals(["a", "b"]);
    const split = splitPaneInLayout({
      layout,
      tabId: tabIds[1],
      targetPaneId: layout.focusedPaneId ?? "",
      position: "right",
      createNodeId: (prefix) => `${prefix}-new`,
      maxTreeDepth: 5,
    });
    if (!split) throw new Error("split failed");
    const moved = moveTabToPaneInLayout({
      layout: split.layout,
      tabId: tabIds[0],
      toPaneId: split.paneId,
    });
    if (!moved) throw new Error("move failed");
    expect(
      collectAllTabs(moved.root)
        .map((tab) => tab.tabId)
        .sort(),
    ).toEqual([...tabIds].sort());
    expect(findClosedTabs(snapshot(layout), snapshot(moved)).closedTabs).toEqual({});
  });

  it("reports a workspace whose layout was removed", () => {
    const { layout } = withTerminals(["a"]);
    const next = { layoutByWorkspace: {}, sheetsByWorkspace: {} };
    expect(findClosedTabs(snapshot(layout), next).removedWorkspaces).toEqual(["w"]);
  });

  it("does not treat a layout that arrives late as a close", () => {
    const { layout } = withTerminals(["a"]);
    const previous = { layoutByWorkspace: {}, sheetsByWorkspace: {} };
    expect(findClosedTabs(previous, snapshot(layout))).toEqual({
      closedTabs: {},
      removedWorkspaces: [],
    });
  });
});
