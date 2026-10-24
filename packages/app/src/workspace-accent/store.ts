import { create } from "zustand";
import type { WorkspaceAccent } from "./model";

interface OverrideEntry {
  /** Identifies who set the override, so one plugin's teardown removes only its own. */
  pluginKey: string;
  color: WorkspaceAccent;
}

interface WorkspaceAccentStoreState {
  /** Entries per `serverId:workspaceId`, in registration order; the first one wins. */
  overridesByKey: Record<string, OverrideEntry[]>;
  setOverride: (input: { workspaceKey: string; pluginKey: string; color: WorkspaceAccent }) => void;
  clearOverride: (input: { workspaceKey: string; pluginKey: string }) => void;
  clearPlugin: (pluginKey: string) => void;
}

export function workspaceAccentKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export const useWorkspaceAccentStore = create<WorkspaceAccentStoreState>((set) => ({
  overridesByKey: {},
  setOverride: ({ workspaceKey, pluginKey, color }) =>
    set((state) => {
      const entries = state.overridesByKey[workspaceKey] ?? [];
      const index = entries.findIndex((entry) => entry.pluginKey === pluginKey);
      if (index >= 0 && entries[index].color === color) return state;
      // Replacing keeps the entry's place, so an update never reshuffles who wins.
      const next =
        index >= 0
          ? entries.map((entry, position) => (position === index ? { pluginKey, color } : entry))
          : [...entries, { pluginKey, color }];
      return { overridesByKey: { ...state.overridesByKey, [workspaceKey]: next } };
    }),
  clearOverride: ({ workspaceKey, pluginKey }) =>
    set((state) => {
      const entries = state.overridesByKey[workspaceKey];
      if (!entries?.some((entry) => entry.pluginKey === pluginKey)) return state;
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
