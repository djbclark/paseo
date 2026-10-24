import { beforeEach, describe, expect, it } from "vitest";
import { selectWorkspaceAccentOverride, useWorkspaceAccentStore } from "./store";

const KEY = "server:workspace";

function read(key = KEY) {
  return selectWorkspaceAccentOverride(useWorkspaceAccentStore.getState(), key);
}

describe("workspace accent store", () => {
  beforeEach(() => {
    useWorkspaceAccentStore.setState({ overridesByKey: {} });
  });

  it("returns the override that registered first", () => {
    const { setOverride } = useWorkspaceAccentStore.getState();
    setOverride({ workspaceKey: KEY, pluginKey: "a", color: "red" });
    setOverride({ workspaceKey: KEY, pluginKey: "b", color: "blue" });
    expect(read()).toBe("red");
  });

  it("keeps an updating plugin's place in line", () => {
    const { setOverride } = useWorkspaceAccentStore.getState();
    setOverride({ workspaceKey: KEY, pluginKey: "a", color: "red" });
    setOverride({ workspaceKey: KEY, pluginKey: "b", color: "blue" });
    setOverride({ workspaceKey: KEY, pluginKey: "a", color: "teal" });
    expect(read()).toBe("teal");
  });

  it("hands the workspace to the next plugin when the first clears", () => {
    const { setOverride, clearOverride } = useWorkspaceAccentStore.getState();
    setOverride({ workspaceKey: KEY, pluginKey: "a", color: "red" });
    setOverride({ workspaceKey: KEY, pluginKey: "b", color: "blue" });
    clearOverride({ workspaceKey: KEY, pluginKey: "a" });
    expect(read()).toBe("blue");
    clearOverride({ workspaceKey: KEY, pluginKey: "b" });
    expect(read()).toBeNull();
    expect(useWorkspaceAccentStore.getState().overridesByKey).toEqual({});
  });

  it("clears every workspace a plugin colored and no one else's", () => {
    const { setOverride, clearPlugin } = useWorkspaceAccentStore.getState();
    setOverride({ workspaceKey: "s:1", pluginKey: "a", color: "red" });
    setOverride({ workspaceKey: "s:2", pluginKey: "a", color: "red" });
    setOverride({ workspaceKey: "s:2", pluginKey: "b", color: "blue" });
    clearPlugin("a");
    expect(read("s:1")).toBeNull();
    expect(read("s:2")).toBe("blue");
  });
});
