import { useMemo } from "react";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { WorkspaceAccent } from "./model";
import { readTabAccents, useWorkspaceTabAccentStore } from "./tab-accent-state";

const NO_ACCENTS: Readonly<Record<string, WorkspaceAccent>> = Object.freeze({});

/** The colors of one workspace's tabs by tab id, for filling `WorkspaceTabDescriptor.accent`. */
export function useTabAccents(
  serverId: string,
  workspaceId: string,
): Readonly<Record<string, WorkspaceAccent>> {
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const stored = useWorkspaceTabAccentStore((state) =>
    workspaceKey ? state.accentsByWorkspace[workspaceKey] : undefined,
  );
  return useMemo(
    () =>
      workspaceKey && stored
        ? readTabAccents({ [workspaceKey]: stored }, workspaceKey)
        : NO_ACCENTS,
    [stored, workspaceKey],
  );
}

export function setTabAccent(
  serverId: string,
  workspaceId: string,
  tabId: string,
  accent: WorkspaceAccent | null,
): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) return;
  useWorkspaceTabAccentStore.getState().setTabAccent(workspaceKey, tabId, accent);
}
