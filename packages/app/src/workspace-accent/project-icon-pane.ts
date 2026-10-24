import { collectAllPanes, type SplitNode } from "@/stores/workspace-layout-store";

/**
 * The one pane whose tab row carries the workspace's project icon: the left-most / top-most
 * visible pane, so the icon sits at the start of the workspace's chrome exactly once. A maximized
 * pane is the only one on screen, so it takes the icon whatever its position.
 */
export function resolveProjectIconPaneId(
  root: SplitNode,
  maximizedPaneId: string | null,
): string | null {
  const panes = collectAllPanes(root);
  if (maximizedPaneId && panes.some((pane) => pane.id === maximizedPaneId)) {
    return maximizedPaneId;
  }
  return panes[0]?.id ?? null;
}
