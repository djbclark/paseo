import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createWorkspaceTabAccentStore, readTabAccents } from "./tab-accent-state";

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
