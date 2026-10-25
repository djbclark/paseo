import { collectAllTabs } from "@/stores/workspace-layout-actions";
import type { SheetTab } from "@/stores/workspace-layout-store";
import type { WorkspaceLayout } from "@/stores/workspace-layout-actions";

interface LayoutSnapshot {
  layoutByWorkspace: Record<string, WorkspaceLayout>;
  sheetsByWorkspace: Record<string, readonly SheetTab[]>;
}

function liveTabIds(snapshot: LayoutSnapshot, workspaceKey: string): Set<string> {
  const layout = snapshot.layoutByWorkspace[workspaceKey];
  const ids = new Set<string>(layout ? collectAllTabs(layout.root).map((tab) => tab.tabId) : []);
  for (const sheet of snapshot.sheetsByWorkspace[workspaceKey] ?? []) ids.add(sheet.tab.tabId);
  return ids;
}

/**
 * What disappeared between two layout states: tabs that were open and are not, and workspaces
 * whose layout was removed. A tab that was never in `previous` is never reported, so a layout
 * that arrives late (hydration) cannot be mistaken for a close.
 */
export function findClosedTabs(
  previous: LayoutSnapshot,
  next: LayoutSnapshot,
): { closedTabs: Record<string, string[]>; removedWorkspaces: string[] } {
  const closedTabs: Record<string, string[]> = {};
  const removedWorkspaces: string[] = [];
  if (
    previous.layoutByWorkspace === next.layoutByWorkspace &&
    previous.sheetsByWorkspace === next.sheetsByWorkspace
  ) {
    return { closedTabs, removedWorkspaces };
  }
  for (const workspaceKey of Object.keys(previous.layoutByWorkspace)) {
    if (!(workspaceKey in next.layoutByWorkspace)) {
      removedWorkspaces.push(workspaceKey);
      continue;
    }
    if (
      previous.layoutByWorkspace[workspaceKey] === next.layoutByWorkspace[workspaceKey] &&
      previous.sheetsByWorkspace[workspaceKey] === next.sheetsByWorkspace[workspaceKey]
    ) {
      continue;
    }
    const before = liveTabIds(previous, workspaceKey);
    const after = liveTabIds(next, workspaceKey);
    const closed = [...before].filter((tabId) => !after.has(tabId));
    if (closed.length > 0) closedTabs[workspaceKey] = closed;
  }
  return { closedTabs, removedWorkspaces };
}

/**
 * Stored colors whose tab is not open in `snapshot`: a tab the layout does not persist (commit
 * diffs), one closed while this build was not running, or a workspace whose layout is gone.
 * Only meaningful once the layout has hydrated.
 */
export function findOrphanedTabs(
  accentsByWorkspace: Readonly<Record<string, Readonly<Record<string, string>>>>,
  snapshot: LayoutSnapshot,
): Record<string, string[]> {
  const orphans: Record<string, string[]> = {};
  for (const [workspaceKey, accents] of Object.entries(accentsByWorkspace)) {
    const live = liveTabIds(snapshot, workspaceKey);
    const gone = Object.keys(accents).filter((tabId) => !live.has(tabId));
    if (gone.length > 0) orphans[workspaceKey] = gone;
  }
  return orphans;
}
