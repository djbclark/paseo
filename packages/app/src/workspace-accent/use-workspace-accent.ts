import { useMemo } from "react";
import { useWorkspaceStructure } from "@/stores/session-store-hooks";
import { findProjectViewKey, resolveWorkspaceAccent, type WorkspaceAccent } from "./model";
import {
  selectWorkspaceAccentOverride,
  useWorkspaceAccentStore,
  workspaceAccentKey,
} from "./store";

/**
 * The accent for one workspace. The project view key comes from the same structure the sidebar
 * groups by, so the derived color matches the sidebar project icon.
 */
export function useWorkspaceAccent(
  serverId: string | null,
  workspaceId: string | null,
): WorkspaceAccent | null {
  const workspaceKey = serverId && workspaceId ? workspaceAccentKey(serverId, workspaceId) : null;
  const serverIds = useMemo(() => (serverId ? [serverId] : []), [serverId]);
  const { projects } = useWorkspaceStructure(serverIds);
  const projectViewKey = useMemo(
    () => (workspaceKey ? findProjectViewKey(projects, workspaceKey) : null),
    [projects, workspaceKey],
  );
  const override = useWorkspaceAccentStore((state) =>
    workspaceKey ? selectWorkspaceAccentOverride(state, workspaceKey) : null,
  );
  return useMemo(
    () => resolveWorkspaceAccent({ override, projectViewKey }),
    [override, projectViewKey],
  );
}
