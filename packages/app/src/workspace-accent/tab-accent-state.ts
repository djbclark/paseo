import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { IDENTITY_COLOR_NAMES } from "@/styles/identity-colors";
import type { WorkspaceAccent } from "./model";
import { findClosedTabs, findOrphanedTabs } from "./tab-accent-prune";

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
  /**
   * A tab took another id or folded into one already open: its color follows. A color the
   * destination already has wins, so the tab the user lands on keeps the color it showed.
   */
  moveTabAccent: (workspaceKey: string, fromTabId: string, intoTabId: string) => void;
  removeTabs: (workspaceKey: string, tabIds: readonly string[]) => void;
  purgeWorkspace: (workspaceKey: string) => void;
}

const NO_ACCENTS: Readonly<Record<string, WorkspaceAccent>> = Object.freeze({});

type AccentsByWorkspace = Record<string, Record<string, string>>;

export function createWorkspaceTabAccentStore(storage: StateStorage) {
  // Edits made while a read of the stored colors is pending. Hydration replaces the whole map, so
  // it replays these over what it loaded; otherwise a color chosen or a tab closed in that window
  // is overwritten by the stored snapshot, and the write for it was already suppressed.
  let editsDuringHydration: ((accents: AccentsByWorkspace) => AccentsByWorkspace)[] = [];
  let storeApi: {
    setState: (
      update: (state: WorkspaceTabAccentState) => Partial<WorkspaceTabAccentState>,
    ) => void;
  } | null = null;
  // A failed read leaves the stored colors unknown. The store then runs from memory for the
  // session: it writes nothing (a write would replace the stored blob with only this session's
  // edits), and hydration never finishes, so reload pruning (which needs the stored colors) never
  // runs against an empty map. The next launch reads the stored colors again.
  let readFailed = false;
  const guardedStorage: StateStorage = {
    getItem: async (name) => {
      try {
        const value = await storage.getItem(name);
        readFailed = false;
        return value;
      } catch (error) {
        readFailed = true;
        throw error;
      }
    },
    setItem: (name, value) => (readFailed ? undefined : storage.setItem(name, value)),
    removeItem: (name) => storage.removeItem(name),
  };
  return create<WorkspaceTabAccentState>()(
    persist<WorkspaceTabAccentState, [], [], z.infer<typeof TabAccentPersistedSchema>>(
      (set, _get, api) => {
        storeApi = api;
        const edit = (apply: (accents: AccentsByWorkspace) => AccentsByWorkspace) => {
          if (!readFailed && !api.persist.hasHydrated()) editsDuringHydration.push(apply);
          set((state) => {
            const next = apply(state.accentsByWorkspace);
            return next === state.accentsByWorkspace ? state : { accentsByWorkspace: next };
          });
        };
        return {
          accentsByWorkspace: {},
          setTabAccent: (workspaceKey, tabId, accent) =>
            edit((accentsByWorkspace) => {
              const current = accentsByWorkspace[workspaceKey] ?? {};
              if ((current[tabId] ?? null) === accent) return accentsByWorkspace;
              const { [tabId]: _removed, ...rest } = current;
              return withWorkspace(
                accentsByWorkspace,
                workspaceKey,
                accent ? { ...rest, [tabId]: accent } : rest,
              );
            }),
          moveTabAccent: (workspaceKey, fromTabId, intoTabId) =>
            edit((accentsByWorkspace) => {
              const current = accentsByWorkspace[workspaceKey];
              const moved = current?.[fromTabId];
              if (!current || moved === undefined || fromTabId === intoTabId) {
                return accentsByWorkspace;
              }
              const { [fromTabId]: _from, ...rest } = current;
              return withWorkspace(accentsByWorkspace, workspaceKey, {
                ...rest,
                [intoTabId]: current[intoTabId] ?? moved,
              });
            }),
          removeTabs: (workspaceKey, tabIds) =>
            edit((accentsByWorkspace) => {
              const current = accentsByWorkspace[workspaceKey];
              if (!current || !tabIds.some((tabId) => tabId in current)) return accentsByWorkspace;
              const rest = Object.fromEntries(
                Object.entries(current).filter(([tabId]) => !tabIds.includes(tabId)),
              );
              return withWorkspace(accentsByWorkspace, workspaceKey, rest);
            }),
          purgeWorkspace: (workspaceKey) =>
            edit((accentsByWorkspace) =>
              workspaceKey in accentsByWorkspace
                ? withWorkspace(accentsByWorkspace, workspaceKey, {})
                : accentsByWorkspace,
            ),
        };
      },
      {
        name: "workspace-tab-accent-state",
        version: 1,
        storage: createValidatedPersistStorage(guardedStorage, TabAccentPersistedSchema),
        partialize: (state) => ({ accentsByWorkspace: state.accentsByWorkspace }),
        merge: (persistedState, currentState) => {
          const result = TabAccentPersistedSchema.safeParse(persistedState);
          const stored = result.success ? (result.data.accentsByWorkspace ?? {}) : {};
          return {
            ...currentState,
            accentsByWorkspace: editsDuringHydration.reduce(
              (accents, apply) => apply(accents),
              stored,
            ),
          };
        },
        onRehydrateStorage: () => (_state, error) => {
          if (error) {
            editsDuringHydration = [];
            return;
          }
          const replayed = editsDuringHydration.length > 0;
          editsDuringHydration = [];
          // The write for those edits was suppressed while the read was pending; save the result.
          if (replayed) {
            storeApi?.setState((state) => ({
              accentsByWorkspace: { ...state.accentsByWorkspace },
            }));
          }
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

type TabAccentStore = ReturnType<typeof createWorkspaceTabAccentStore>;
type LayoutStore = Pick<
  typeof useWorkspaceLayoutStore,
  "subscribe" | "getState" | "persist" | "onTabMerged"
>;

/**
 * A closed tab or a purged workspace takes its color with it. The layout store has several
 * closing paths (menu, bulk close, agent archive, workspace archive); watching its state covers
 * them all. Only a tab seen in the previous state is pruned, so the layout store hydrating or
 * reconciling later never costs a color.
 *
 * That watch never sees a tab that was gone before this process started (the layout does not
 * persist commit diffs, and a color can outlive its tab across builds), so once both stores have
 * hydrated, colors for tabs the restored layout does not hold are dropped in one pass.
 *
 * A tab that takes another id, or folds into one already open, is not a close: the layout store
 * announces it before publishing the layout, and its color follows (see `moveTabAccent`).
 */
export function bindTabAccentPruning(layout: LayoutStore, accents: TabAccentStore): () => void {
  const stopMerges = layout.onTabMerged((workspaceKey, fromTabId, intoTabId) =>
    accents.getState().moveTabAccent(workspaceKey, fromTabId, intoTabId),
  );
  const unsubscribe = layout.subscribe((state, previous) => {
    if (!layout.persist.hasHydrated()) return;
    const { closedTabs, removedWorkspaces } = findClosedTabs(previous, state);
    const store = accents.getState();
    for (const workspaceKey of removedWorkspaces) store.purgeWorkspace(workspaceKey);
    for (const [workspaceKey, tabIds] of Object.entries(closedTabs)) {
      store.removeTabs(workspaceKey, tabIds);
    }
  });

  let disposed = false;
  const stopWaiting: (() => void)[] = [];
  const whenHydrated = (store: LayoutStore | TabAccentStore, then: () => void) => {
    if (store.persist.hasHydrated()) then();
    else stopWaiting.push(store.persist.onFinishHydration(then));
  };
  whenHydrated(layout, () =>
    whenHydrated(accents, () => {
      if (disposed) return;
      const orphans = findOrphanedTabs(accents.getState().accentsByWorkspace, layout.getState());
      for (const [workspaceKey, tabIds] of Object.entries(orphans)) {
        accents.getState().removeTabs(workspaceKey, tabIds);
      }
    }),
  );

  return () => {
    disposed = true;
    unsubscribe();
    stopMerges();
    for (const stop of stopWaiting) stop();
  };
}

bindTabAccentPruning(useWorkspaceLayoutStore, useWorkspaceTabAccentStore);
