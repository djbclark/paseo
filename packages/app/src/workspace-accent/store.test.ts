import { beforeEach, describe, expect, it } from "vitest";
import { selectWorkspaceAccentOverride, useWorkspaceAccentStore } from "./store";

const KEY = "server:workspace";
const OWNER = Symbol("test");

function read(key = KEY) {
  return selectWorkspaceAccentOverride(useWorkspaceAccentStore.getState(), key);
}

describe("workspace accent store", () => {
  beforeEach(() => {
    useWorkspaceAccentStore.setState({ overridesByKey: {} });
  });

  it("returns the override that registered first", () => {
    const { setOverride } = useWorkspaceAccentStore.getState();
    setOverride({ workspaceKey: KEY, pluginKey: "a", color: "red", owner: OWNER });
    setOverride({ workspaceKey: KEY, pluginKey: "b", color: "blue", owner: OWNER });
    expect(read()).toBe("red");
  });

  it("ranks by plugin key, not by who registered first", () => {
    const { setOverride, clearOverride } = useWorkspaceAccentStore.getState();
    setOverride({ workspaceKey: KEY, pluginKey: "host/b", color: "blue", owner: OWNER });
    setOverride({ workspaceKey: KEY, pluginKey: "host/a", color: "red", owner: OWNER });
    expect(read()).toBe("red");
    clearOverride({ workspaceKey: KEY, pluginKey: "host/a", owner: OWNER });
    expect(read()).toBe("blue");
  });

  it("keeps an updating plugin's place in line", () => {
    const { setOverride } = useWorkspaceAccentStore.getState();
    setOverride({ workspaceKey: KEY, pluginKey: "a", color: "red", owner: OWNER });
    setOverride({ workspaceKey: KEY, pluginKey: "b", color: "blue", owner: OWNER });
    setOverride({ workspaceKey: KEY, pluginKey: "a", color: "teal", owner: OWNER });
    expect(read()).toBe("teal");
  });

  it("hands the workspace to the next plugin when the first clears", () => {
    const { setOverride, clearOverride } = useWorkspaceAccentStore.getState();
    setOverride({ workspaceKey: KEY, pluginKey: "a", color: "red", owner: OWNER });
    setOverride({ workspaceKey: KEY, pluginKey: "b", color: "blue", owner: OWNER });
    clearOverride({ workspaceKey: KEY, pluginKey: "a", owner: OWNER });
    expect(read()).toBe("blue");
    clearOverride({ workspaceKey: KEY, pluginKey: "b", owner: OWNER });
    expect(read()).toBeNull();
    expect(useWorkspaceAccentStore.getState().overridesByKey).toEqual({});
  });

  it("clears every workspace a plugin colored and no one else's", () => {
    const { setOverride, clearPlugin } = useWorkspaceAccentStore.getState();
    setOverride({ workspaceKey: "s:1", pluginKey: "a", color: "red", owner: OWNER });
    setOverride({ workspaceKey: "s:2", pluginKey: "a", color: "red", owner: OWNER });
    setOverride({ workspaceKey: "s:2", pluginKey: "b", color: "blue", owner: OWNER });
    clearPlugin("a");
    expect(read("s:1")).toBeNull();
    expect(read("s:2")).toBe("blue");
  });
});
