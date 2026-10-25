import type {
  PluginWorkspaceAccentContribution,
  PluginWorkspaceAccentRegistration,
} from "@getpaseo/plugin/client";
import { isWorkspaceAccent, type WorkspaceAccent } from "./model";
import { useWorkspaceAccentStore, workspaceAccentKey } from "./store";

function requireColor(color: unknown): WorkspaceAccent {
  if (!isWorkspaceAccent(color))
    throw new Error(`Invalid workspace accent color: ${String(color)}`);
  return color;
}

/** One plugin installation's workspace colors; a later call for a workspace replaces the earlier one. */
export function createWorkspaceAccentRegistrar(installation: { serverId: string; id: string }): {
  set(contribution: PluginWorkspaceAccentContribution): PluginWorkspaceAccentRegistration;
} {
  const pluginKey = `${installation.serverId}/${installation.id}`;
  return {
    set(contribution) {
      const workspaceId = contribution.workspaceId.trim();
      if (!workspaceId) throw new Error("Workspace accent needs a workspaceId");
      const workspaceKey = workspaceAccentKey(installation.serverId, workspaceId);
      const color = requireColor(contribution.color);
      // The store keeps who owns each entry, so a replaced handle, or the same plugin's previous
      // installation tearing down late, cannot change or clear its successor's color.
      const owner = Symbol(workspaceId);
      const store = useWorkspaceAccentStore.getState();
      store.setOverride({ workspaceKey, pluginKey, color, owner });
      return {
        update({ color: nextColor }) {
          const next = requireColor(nextColor);
          useWorkspaceAccentStore
            .getState()
            .updateOverride({ workspaceKey, pluginKey, color: next, owner });
        },
        remove() {
          useWorkspaceAccentStore.getState().clearOverride({ workspaceKey, pluginKey, owner });
        },
      };
    },
  };
}
