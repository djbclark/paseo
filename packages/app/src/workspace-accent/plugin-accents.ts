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
  // The token of the live registration per workspace, so a replaced handle cannot clear its successor.
  const live = new Map<string, symbol>();
  return {
    set(contribution) {
      const workspaceId = contribution.workspaceId.trim();
      if (!workspaceId) throw new Error("Workspace accent needs a workspaceId");
      const workspaceKey = workspaceAccentKey(installation.serverId, workspaceId);
      const apply = (color: WorkspaceAccent) =>
        useWorkspaceAccentStore.getState().setOverride({ workspaceKey, pluginKey, color });
      apply(requireColor(contribution.color));
      const token = Symbol(workspaceId);
      live.set(workspaceId, token);
      return {
        update({ color }) {
          const next = requireColor(color);
          if (live.get(workspaceId) === token) apply(next);
        },
        remove() {
          if (live.get(workspaceId) !== token) return;
          live.delete(workspaceId);
          useWorkspaceAccentStore.getState().clearOverride({ workspaceKey, pluginKey });
        },
      };
    },
  };
}
