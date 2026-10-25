import { create } from "zustand";
import type { WorkspaceAccent } from "./model";

interface OverrideEntry {
  /** Identifies who set the override, so one plugin's teardown removes only its own. */
  pluginKey: string;
  color: WorkspaceAccent;
  /**
   * The registration that set the color. A plugin reloaded under the same id has the same
   * `pluginKey`, so only this tells the old installation's teardown from the new one's color.
   */
  owner: symbol;
}

interface WorkspaceAccentStoreState {
  /** Entries per `serverId:workspaceId`, sorted by plugin key like the registry snapshot; the first one wins. */
  overridesByKey: Record<string, OverrideEntry[]>;
  /** Sets the plugin's color for the workspace, taking the entry over from any earlier owner. */
  setOverride: (input: {
    workspaceKey: string;
    pluginKey: string;
    color: WorkspaceAccent;
    owner: symbol;
  }) => void;
  /** Recolors the entry, but only while `owner` still holds it. */
  updateOverride: (input: {
    workspaceKey: string;
    pluginKey: string;
    color: WorkspaceAccent;
    owner: symbol;
  }) => void;
  /** Removes the entry, but only while `owner` still holds it. */
  clearOverride: (input: { workspaceKey: string; pluginKey: string; owner: symbol }) => void;
  clearPlugin: (pluginKey: string) => void;
}

export function workspaceAccentKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export const useWorkspaceAccentStore = create<WorkspaceAccentStoreState>((set) => ({
  overridesByKey: {},
  setOverride: ({ workspaceKey, pluginKey, color, owner }) =>
    set((state) => {
      const entries = state.overridesByKey[workspaceKey] ?? [];
      const index = entries.findIndex((entry) => entry.pluginKey === pluginKey);
      if (index >= 0 && entries[index].color === color && entries[index].owner === owner) {
        return state;
      }
      // Replacing keeps the entry's place, so an update never reshuffles who wins.
      const next =
        index >= 0
          ? entries.map((entry, position) =>
              position === index ? { pluginKey, color, owner } : entry,
            )
          : [...entries, { pluginKey, color, owner }].sort((a, b) =>
              a.pluginKey.localeCompare(b.pluginKey),
            );
      return { overridesByKey: { ...state.overridesByKey, [workspaceKey]: next } };
    }),
  updateOverride: ({ workspaceKey, pluginKey, color, owner }) =>
    set((state) => {
      const entries = state.overridesByKey[workspaceKey] ?? [];
      const index = entries.findIndex(
        (entry) => entry.pluginKey === pluginKey && entry.owner === owner,
      );
      if (index < 0 || entries[index].color === color) return state;
      const next = entries.map((entry, position) =>
        position === index ? { pluginKey, color, owner } : entry,
      );
      return { overridesByKey: { ...state.overridesByKey, [workspaceKey]: next } };
    }),
  clearOverride: ({ workspaceKey, pluginKey, owner }) =>
    set((state) => {
      const entries = state.overridesByKey[workspaceKey];
      if (!entries?.some((entry) => entry.pluginKey === pluginKey && entry.owner === owner)) {
        return state;
      }
      return {
        overridesByKey: withEntries(
          state.overridesByKey,
          workspaceKey,
          entries.filter((entry) => entry.pluginKey !== pluginKey),
        ),
      };
    }),
  clearPlugin: (pluginKey) =>
    set((state) => {
      let next = state.overridesByKey;
      for (const [workspaceKey, entries] of Object.entries(state.overridesByKey)) {
        if (!entries.some((entry) => entry.pluginKey === pluginKey)) continue;
        next = withEntries(
          next,
          workspaceKey,
          entries.filter((entry) => entry.pluginKey !== pluginKey),
        );
      }
      return next === state.overridesByKey ? state : { overridesByKey: next };
    }),
}));

function withEntries(
  overridesByKey: Record<string, OverrideEntry[]>,
  workspaceKey: string,
  entries: OverrideEntry[],
): Record<string, OverrideEntry[]> {
  const { [workspaceKey]: _removed, ...rest } = overridesByKey;
  return entries.length > 0 ? { ...rest, [workspaceKey]: entries } : rest;
}

export function selectWorkspaceAccentOverride(
  state: WorkspaceAccentStoreState,
  workspaceKey: string,
): WorkspaceAccent | null {
  return state.overridesByKey[workspaceKey]?.[0]?.color ?? null;
}
