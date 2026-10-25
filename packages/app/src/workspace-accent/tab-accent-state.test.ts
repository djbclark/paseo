import { describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  bindTabAccentPruning,
  createWorkspaceTabAccentStore,
  readTabAccents,
} from "./tab-accent-state";

const KEY = "server:workspace";

function memoryStorage(initial: Record<string, string> = {}): StateStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => void values.set(name, value),
    removeItem: (name) => void values.delete(name),
  };
}

function blob(state: unknown): string {
  return JSON.stringify({ state, version: 1 });
}

const ACCENT_BLOB = "workspace-tab-accent-state";

/** Storage whose first read stays pending until `release()`, like a slow AsyncStorage. */
function deferredStorage(initial: Record<string, string> = {}) {
  const storage = memoryStorage(initial);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ...storage,
    getItem: async (name: string) => {
      await gate;
      return storage.getItem(name);
    },
    release,
  };
}

function hydrated(store: {
  persist: { hasHydrated(): boolean; onFinishHydration(cb: () => void): unknown };
}) {
  return new Promise<void>((resolve) => {
    if (store.persist.hasHydrated()) resolve();
    else store.persist.onFinishHydration(() => resolve());
  });
}

function stored(storage: { values: Map<string, string> }) {
  const raw = storage.values.get(ACCENT_BLOB);
  return raw ? JSON.parse(raw).state.accentsByWorkspace : undefined;
}

describe("workspace tab accent store", () => {
  it("sets, replaces and clears a tab's color", () => {
    const store = createWorkspaceTabAccentStore(memoryStorage());
    store.getState().setTabAccent(KEY, "tab-1", "red");
    expect(readTabAccents(store.getState().accentsByWorkspace, KEY)).toEqual({ "tab-1": "red" });
    store.getState().setTabAccent(KEY, "tab-1", "blue");
    expect(readTabAccents(store.getState().accentsByWorkspace, KEY)).toEqual({ "tab-1": "blue" });
    store.getState().setTabAccent(KEY, "tab-1", null);
    expect(store.getState().accentsByWorkspace).toEqual({});
  });

  it("prunes closed tabs and purged workspaces", () => {
    const store = createWorkspaceTabAccentStore(memoryStorage());
    const { setTabAccent, removeTabs, purgeWorkspace } = store.getState();
    setTabAccent(KEY, "a", "red");
    setTabAccent(KEY, "b", "blue");
    setTabAccent("other:ws", "c", "teal");
    removeTabs(KEY, ["a"]);
    expect(store.getState().accentsByWorkspace).toEqual({
      [KEY]: { b: "blue" },
      "other:ws": { c: "teal" },
    });
    purgeWorkspace(KEY);
    expect(store.getState().accentsByWorkspace).toEqual({ "other:ws": { c: "teal" } });
  });

  it("reads a color name this build does not know as no color", () => {
    expect(readTabAccents({ [KEY]: { a: "red", b: "chartreuse" } }, KEY)).toEqual({ a: "red" });
  });

  it("restores a stored blob, ignoring keys it does not know", async () => {
    const storage = memoryStorage({
      "workspace-tab-accent-state": blob({
        accentsByWorkspace: { [KEY]: { a: "pink", b: "chartreuse" } },
        addedByALaterBuild: true,
      }),
    });
    const store = createWorkspaceTabAccentStore(storage);
    await store.persist.rehydrate();
    expect(readTabAccents(store.getState().accentsByWorkspace, KEY)).toEqual({ a: "pink" });
  });

  it("restores a blob that predates the field", async () => {
    const storage = memoryStorage({ "workspace-tab-accent-state": blob({}) });
    const store = createWorkspaceTabAccentStore(storage);
    await store.persist.rehydrate();
    expect(store.getState().accentsByWorkspace).toEqual({});
    expect(storage.values.has("workspace-tab-accent-state")).toBe(true);
  });
});

describe("hydration racing with edits", () => {
  it("keeps a color chosen while the first read is pending, and saves it", async () => {
    const storage = deferredStorage({
      [ACCENT_BLOB]: blob({ accentsByWorkspace: { [KEY]: { a: "red" } } }),
    });
    const store = createWorkspaceTabAccentStore(storage);
    store.getState().setTabAccent(KEY, "b", "blue");
    storage.release();
    await hydrated(store);
    expect(store.getState().accentsByWorkspace).toEqual({ [KEY]: { a: "red", b: "blue" } });
    await expect.poll(() => stored(storage)).toEqual({ [KEY]: { a: "red", b: "blue" } });
  });

  it("keeps a color chosen on a fresh install while the first read is pending", async () => {
    const storage = deferredStorage();
    const store = createWorkspaceTabAccentStore(storage);
    store.getState().setTabAccent(KEY, "b", "blue");
    storage.release();
    await hydrated(store);
    expect(store.getState().accentsByWorkspace).toEqual({ [KEY]: { b: "blue" } });
    await expect.poll(() => stored(storage)).toEqual({ [KEY]: { b: "blue" } });
  });

  it("does not restore a color for a tab closed while the first read is pending", async () => {
    const storage = deferredStorage({
      [ACCENT_BLOB]: blob({
        accentsByWorkspace: { [KEY]: { a: "red", b: "blue" }, "o:w": { c: "teal" } },
      }),
    });
    const store = createWorkspaceTabAccentStore(storage);
    store.getState().removeTabs(KEY, ["a"]);
    store.getState().purgeWorkspace("o:w");
    storage.release();
    await hydrated(store);
    expect(store.getState().accentsByWorkspace).toEqual({ [KEY]: { b: "blue" } });
    await expect.poll(() => stored(storage)).toEqual({ [KEY]: { b: "blue" } });
  });

  describe("when the first read fails", () => {
    /** A storage whose read rejects once released, with a stored blob it must keep. */
    function failingStorage() {
      const storage = memoryStorage({
        [ACCENT_BLOB]: blob({ accentsByWorkspace: { [KEY]: { a: "red" } } }),
      });
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      return {
        ...storage,
        getItem: async () => {
          await gate;
          throw new Error("disk unavailable");
        },
        release,
      };
    }
    // A failed hydration emits no event, so drain its promise chain with one macrotask turn.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("keeps edits in memory without writing over the stored colors", async () => {
      const storage = failingStorage();
      const original = storage.values.get(ACCENT_BLOB);
      const store = createWorkspaceTabAccentStore(storage);
      store.getState().setTabAccent(KEY, "pending", "blue");
      storage.release();
      await settle();
      store.getState().setTabAccent(KEY, "later", "teal");
      await settle();
      expect(store.persist.hasHydrated()).toBe(false);
      expect(store.getState().accentsByWorkspace).toEqual({
        [KEY]: { pending: "blue", later: "teal" },
      });
      expect(storage.values.get(ACCENT_BLOB)).toBe(original);
    });

    it("does not prune against the unknown stored colors", async () => {
      const storage = failingStorage();
      const store = createWorkspaceTabAccentStore(storage);
      const layout = createWorkspaceLayoutStore(undefined, memoryStorage());
      await layout.persist.rehydrate();
      const unbind = bindTabAccentPruning(layout, store);
      storage.release();
      await settle();
      store.getState().setTabAccent(KEY, "gone", "red");
      await settle();
      expect(store.getState().accentsByWorkspace).toEqual({ [KEY]: { gone: "red" } });
      unbind();
    });
  });
});

describe("reload reconciliation", () => {
  const WORKSPACE = "server:workspace";

  it("drops colors of tabs the restored layout no longer has", async () => {
    const layoutStorage = memoryStorage();
    const accentStorage = memoryStorage();

    // First run: a terminal tab and a commit diff tab, both colored, plus a color for a workspace
    // whose layout never persisted.
    const layout = createWorkspaceLayoutStore(undefined, layoutStorage);
    await layout.persist.rehydrate();
    const accents = createWorkspaceTabAccentStore(accentStorage);
    await accents.persist.rehydrate();
    bindTabAccentPruning(layout, accents);
    const terminalTab = layout.getState().openTab({
      workspaceKey: WORKSPACE,
      target: { kind: "terminal", terminalId: "t1" },
      intent: "reveal",
    });
    const diffTab = layout.getState().openTab({
      workspaceKey: WORKSPACE,
      target: { kind: "commit_diff", sha: "abc1234" },
      intent: "reveal",
    });
    if (!terminalTab || !diffTab) throw new Error("open failed");
    accents.getState().setTabAccent(WORKSPACE, terminalTab, "red");
    accents.getState().setTabAccent(WORKSPACE, diffTab, "blue");
    accents.getState().setTabAccent("server:gone", "x", "teal");
    await expect
      .poll(() => stored(accentStorage)?.[WORKSPACE])
      .toEqual({
        [terminalTab]: "red",
        [diffTab]: "blue",
      });

    // Reload: the layout strips the commit diff tab and never saw the other workspace.
    const restoredLayout = createWorkspaceLayoutStore(undefined, layoutStorage);
    const restoredAccents = createWorkspaceTabAccentStore(accentStorage);
    bindTabAccentPruning(restoredLayout, restoredAccents);
    await Promise.all([hydrated(restoredLayout), hydrated(restoredAccents)]);

    expect(restoredAccents.getState().accentsByWorkspace).toEqual({
      [WORKSPACE]: { [terminalTab]: "red" },
    });
    await expect
      .poll(() => stored(accentStorage))
      .toEqual({
        [WORKSPACE]: { [terminalTab]: "red" },
      });
  });
});

describe("a tab whose id changes", () => {
  async function boundStores() {
    const layout = createWorkspaceLayoutStore(undefined, memoryStorage());
    await layout.persist.rehydrate();
    const accents = createWorkspaceTabAccentStore(memoryStorage());
    await accents.persist.rehydrate();
    bindTabAccentPruning(layout, accents);
    return { layout, accents };
  }

  type Stores = Awaited<ReturnType<typeof boundStores>>;

  function open(layout: Stores["layout"], target: WorkspaceTabTarget, intent: "reveal" | "new") {
    const tabId = layout.getState().openTab({ workspaceKey: KEY, target, intent });
    if (!tabId) throw new Error("open failed");
    return tabId;
  }

  const AGENT: WorkspaceTabTarget = { kind: "agent", agentId: "agent-1" };
  const SNAPSHOT = {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: ["agent-1"],
    autoOpenAgentIds: ["agent-1"],
    standaloneTerminalIds: [] as string[],
  };

  /** An agent tab with its canonical id, and a draft-origin tab for the same agent. */
  function openAgentAndDraftOriginDuplicate(layout: Stores["layout"]) {
    const keeperTabId = open(layout, AGENT, "reveal");
    const duplicateTabId = open(layout, { kind: "draft", draftId: "d1" }, "reveal");
    layout.getState().replaceTab(KEY, duplicateTabId, AGENT);
    return { keeperTabId, duplicateTabId };
  }

  function agentTabIds(layout: Stores["layout"]): string[] {
    return layout
      .getState()
      .getWorkspaceTabs(KEY)
      .filter((tab) => tab.target.kind === "agent")
      .map((tab) => tab.tabId);
  }

  it("replacing an agent tab with a draft: keeps the color on the draft tab it becomes", async () => {
    const { layout, accents } = await boundStores();
    const agentTabId = open(layout, AGENT, "reveal");
    accents.getState().setTabAccent(KEY, agentTabId, "red");

    const draftTabId = layout
      .getState()
      .replaceTab(KEY, agentTabId, { kind: "draft", draftId: "d1" });

    expect(draftTabId).not.toBe(agentTabId);
    expect(accents.getState().accentsByWorkspace).toEqual({ [KEY]: { [draftTabId!]: "red" } });
  });

  it("replacing an agent tab with a draft: leaves other tabs' colors alone", async () => {
    const { layout, accents } = await boundStores();
    const agentTabId = open(layout, AGENT, "reveal");
    const terminalTabId = open(layout, { kind: "terminal", terminalId: "t1" }, "reveal");
    accents.getState().setTabAccent(KEY, terminalTabId, "blue");

    layout.getState().replaceTab(KEY, agentTabId, { kind: "draft", draftId: "d1" });

    expect(accents.getState().accentsByWorkspace).toEqual({ [KEY]: { [terminalTabId]: "blue" } });
  });

  it("replacing an agent tab with a draft: applies the move that was made while the stored colors were still loading", async () => {
    const storage = deferredStorage();
    const accents = createWorkspaceTabAccentStore(storage);
    const layout = createWorkspaceLayoutStore(undefined, memoryStorage());
    await layout.persist.rehydrate();
    bindTabAccentPruning(layout, accents);
    const agentTabId = open(layout, AGENT, "reveal");
    accents.getState().setTabAccent(KEY, agentTabId, "red");

    const draftTabId = layout
      .getState()
      .replaceTab(KEY, agentTabId, { kind: "draft", draftId: "d1" });
    storage.release();
    await hydrated(accents);

    expect(accents.getState().accentsByWorkspace).toEqual({ [KEY]: { [draftTabId!]: "red" } });
  });

  it("a draft that starts an agent: keeps its id and its color", async () => {
    const { layout, accents } = await boundStores();
    const draftTabId = open(layout, { kind: "draft", draftId: "d1" }, "reveal");
    accents.getState().setTabAccent(KEY, draftTabId, "red");

    const agentTabId = layout.getState().replaceTab(KEY, draftTabId, AGENT);

    expect(agentTabId).toBe(draftTabId);
    expect(accents.getState().accentsByWorkspace).toEqual({ [KEY]: { [draftTabId]: "red" } });
  });

  it("a duplicate tab for the same agent folding into the canonical one: gives an uncolored canonical tab the duplicate's color", async () => {
    const { layout, accents } = await boundStores();
    const { keeperTabId, duplicateTabId } = openAgentAndDraftOriginDuplicate(layout);
    accents.getState().setTabAccent(KEY, duplicateTabId, "red");

    layout.getState().reconcileTabs(KEY, SNAPSHOT);

    expect(agentTabIds(layout)).toEqual([keeperTabId]);
    expect(accents.getState().accentsByWorkspace).toEqual({ [KEY]: { [keeperTabId]: "red" } });
  });

  it("a duplicate tab for the same agent folding into the canonical one: lets a colored canonical tab keep its own color", async () => {
    const { layout, accents } = await boundStores();
    const { keeperTabId, duplicateTabId } = openAgentAndDraftOriginDuplicate(layout);
    accents.getState().setTabAccent(KEY, duplicateTabId, "red");
    accents.getState().setTabAccent(KEY, keeperTabId, "blue");

    layout.getState().reconcileTabs(KEY, SNAPSHOT);

    expect(accents.getState().accentsByWorkspace).toEqual({ [KEY]: { [keeperTabId]: "blue" } });
  });

  it("a duplicate tab for the same agent folding into the canonical one: keeps the canonical tab's color when the duplicate has none", async () => {
    const { layout, accents } = await boundStores();
    const { keeperTabId } = openAgentAndDraftOriginDuplicate(layout);
    accents.getState().setTabAccent(KEY, keeperTabId, "blue");

    layout.getState().reconcileTabs(KEY, SNAPSHOT);

    expect(accents.getState().accentsByWorkspace).toEqual({ [KEY]: { [keeperTabId]: "blue" } });
  });

  it("the layout store's notification: still changes the layout when a listener throws, and tells the listeners after it", async () => {
    const { layout, accents } = await boundStores();
    const heard: string[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    layout.onTabMerged(() => {
      throw new Error("listener failed");
    });
    layout.onTabMerged((_workspaceKey, from, into) => heard.push(`${from}>${into}`));
    const agentTabId = open(layout, AGENT, "reveal");
    accents.getState().setTabAccent(KEY, agentTabId, "red");

    const draftTabId = layout
      .getState()
      .replaceTab(KEY, agentTabId, { kind: "draft", draftId: "d1" });

    const tabIds = layout
      .getState()
      .getWorkspaceTabs(KEY)
      .map((tab) => tab.tabId);
    expect(tabIds).toContain(draftTabId);
    expect(tabIds).not.toContain(agentTabId);
    expect(heard).toEqual([`${agentTabId}>${draftTabId}`]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
    expect(accents.getState().accentsByWorkspace).toEqual({ [KEY]: { [draftTabId!]: "red" } });
  });

  it("the layout store's notification: lets a listener unsubscribe another during dispatch", async () => {
    const { layout } = await boundStores();
    const heard: string[] = [];
    const stopSecond = layout.onTabMerged(() => {});
    layout.onTabMerged(() => {
      heard.push("first");
      stopSecond();
    });
    layout.onTabMerged(() => heard.push("third"));
    const agentTabId = open(layout, AGENT, "reveal");

    layout.getState().replaceTab(KEY, agentTabId, { kind: "draft", draftId: "d1" });

    expect(heard).toEqual(["first", "third"]);
  });

  it("the layout store's notification: does not fire for a replacement that keeps the tab id", async () => {
    const { layout } = await boundStores();
    const heard: string[] = [];
    layout.onTabMerged((_workspaceKey, from) => heard.push(from));
    const draftTabId = open(layout, { kind: "draft", draftId: "d1" }, "reveal");

    layout.getState().replaceTab(KEY, draftTabId, AGENT);

    expect(heard).toEqual([]);
  });
});
