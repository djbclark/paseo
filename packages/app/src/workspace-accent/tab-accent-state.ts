import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { IDENTITY_COLOR_NAMES } from "@/styles/identity-colors";
import type { WorkspaceAccent } from "./model";
import { findClosedTabs } from "./tab-accent-prune";

/**
 * A tab's color lives here, not on `WorkspaceTab`: the layout schema is strict and a blob that
 * fails validation is deleted, so an older build reading a new tab key would wipe every layout.
 * Colors are per device, like the layout they decorate.
 *
 * Values are plain strings on disk and checked on read, so a color name that later disappears
 * costs one tab its color instead of the whole store.
 */
const TabAccentPersistedSchema = z.object({
  accentsByWorkspace: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

interface WorkspaceTabAccentState {
  /** `serverId:workspaceId` → tab id → color name. */
  accentsByWorkspace: Record<string, Record<string, string>>;
  setTabAccent: (workspaceKey: string, tabId: string, accent: WorkspaceAccent | null) => void;
  removeTabs: (workspaceKey: string, tabIds: readonly string[]) => void;
  purgeWorkspace: (workspaceKey: string) => void;
}

const NO_ACCENTS: Readonly<Record<string, WorkspaceAccent>> = Object.freeze({});

export function createWorkspaceTabAccentStore(storage: StateStorage) {
  return create<WorkspaceTabAccentState>()(
    persist<WorkspaceTabAccentState, [], [], z.infer<typeof TabAccentPersistedSchema>>(
      (set) => ({
        accentsByWorkspace: {},
        setTabAccent: (workspaceKey, tabId, accent) =>
          set((state) => {
            const current = state.accentsByWorkspace[workspaceKey] ?? {};
            if ((current[tabId] ?? null) === accent) return state;
            const { [tabId]: _removed, ...rest } = current;
            return {
              accentsByWorkspace: withWorkspace(
                state.accentsByWorkspace,
                workspaceKey,
                accent ? { ...rest, [tabId]: accent } : rest,
              ),
            };
          }),
        removeTabs: (workspaceKey, tabIds) =>
          set((state) => {
            const current = state.accentsByWorkspace[workspaceKey];
            if (!current || !tabIds.some((tabId) => tabId in current)) return state;
            const rest = Object.fromEntries(
              Object.entries(current).filter(([tabId]) => !tabIds.includes(tabId)),
            );
            return {
              accentsByWorkspace: withWorkspace(state.accentsByWorkspace, workspaceKey, rest),
            };
          }),
        purgeWorkspace: (workspaceKey) =>
          set((state) => {
            if (!(workspaceKey in state.accentsByWorkspace)) return state;
            return {
              accentsByWorkspace: withWorkspace(state.accentsByWorkspace, workspaceKey, {}),
            };
          }),
      }),
      {
        name: "workspace-tab-accent-state",
        version: 1,
        storage: createValidatedPersistStorage(storage, TabAccentPersistedSchema),
        partialize: (state) => ({ accentsByWorkspace: state.accentsByWorkspace }),
        merge: (persistedState, currentState) => {
          const result = TabAccentPersistedSchema.safeParse(persistedState);
          return {
            ...currentState,
            accentsByWorkspace: result.success ? (result.data.accentsByWorkspace ?? {}) : {},
          };
        },
      },
    ),
  );
}

function withWorkspace(
  accentsByWorkspace: Record<string, Record<string, string>>,
  workspaceKey: string,
  accents: Record<string, string>,
): Record<string, Record<string, string>> {
  const { [workspaceKey]: _removed, ...rest } = accentsByWorkspace;
  return Object.keys(accents).length > 0 ? { ...rest, [workspaceKey]: accents } : rest;
}

/** The stored colors for one workspace, with names this build does not know dropped. */
export function readTabAccents(
  accentsByWorkspace: Record<string, Record<string, string>>,
  workspaceKey: string,
): Readonly<Record<string, WorkspaceAccent>> {
  const stored = accentsByWorkspace[workspaceKey];
  if (!stored) return NO_ACCENTS;
  const known = Object.entries(stored).filter(([, name]) =>
    (IDENTITY_COLOR_NAMES as readonly string[]).includes(name),
  );
  return Object.fromEntries(known) as Record<string, WorkspaceAccent>;
}

export const useWorkspaceTabAccentStore = createWorkspaceTabAccentStore(AsyncStorage);

// A closed tab or a purged workspace takes its color with it. The layout store has several
// closing paths (menu, bulk close, agent archive, workspace archive); watching its state covers
// them all. Only a tab seen in the previous state is pruned, so the layout store hydrating or
// reconciling later never costs a color.
useWorkspaceLayoutStore.subscribe((state, previous) => {
  if (!useWorkspaceLayoutStore.persist.hasHydrated()) return;
  const { closedTabs, removedWorkspaces } = findClosedTabs(previous, state);
  const store = useWorkspaceTabAccentStore.getState();
  for (const workspaceKey of removedWorkspaces) store.purgeWorkspace(workspaceKey);
  for (const [workspaceKey, tabIds] of Object.entries(closedTabs)) {
    store.removeTabs(workspaceKey, tabIds);
  }
});
