import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceAccentRegistrar } from "./plugin-accents";
import { selectWorkspaceAccentOverride, useWorkspaceAccentStore } from "./store";

function read(workspaceId = "w1") {
  return selectWorkspaceAccentOverride(useWorkspaceAccentStore.getState(), `host:${workspaceId}`);
}

const registrar = (id: string) => createWorkspaceAccentRegistrar({ serverId: "host", id });

describe("workspace accent registrar", () => {
  beforeEach(() => {
    useWorkspaceAccentStore.setState({ overridesByKey: {} });
  });

  it("sets, updates and removes a workspace's color", () => {
    const registration = registrar("colors").set({ workspaceId: "w1", color: "teal" });
    expect(read()).toBe("teal");
    registration.update({ color: "red" });
    expect(read()).toBe("red");
    registration.remove();
    expect(read()).toBeNull();
  });

  it("throws on an invalid color in set and in update", () => {
    const accents = registrar("colors");
    expect(() => accents.set({ workspaceId: "w1", color: "magenta" as unknown as "red" })).toThrow(
      "Invalid workspace accent color: magenta",
    );
    const registration = accents.set({ workspaceId: "w1", color: "teal" });
    expect(() => registration.update({ color: "magenta" as unknown as "red" })).toThrow(
      "Invalid workspace accent color: magenta",
    );
    expect(read()).toBe("teal");
  });

  it("throws on an empty workspace id", () => {
    expect(() => registrar("colors").set({ workspaceId: "  ", color: "red" })).toThrow();
  });

  it("replaces an earlier registration and leaves its handle inert", () => {
    const accents = registrar("colors");
    const first = accents.set({ workspaceId: "w1", color: "teal" });
    const second = accents.set({ workspaceId: "w1", color: "red" });
    first.update({ color: "blue" });
    first.remove();
    expect(read()).toBe("red");
    second.remove();
    expect(read()).toBeNull();
  });

  it("removes idempotently", () => {
    const registration = registrar("colors").set({ workspaceId: "w1", color: "teal" });
    registration.remove();
    registration.remove();
    registration.update({ color: "red" });
    expect(read()).toBeNull();
  });

  it("ranks plugins by plugin key, whatever order they set in", () => {
    registrar("zeta").set({ workspaceId: "w1", color: "blue" });
    const alpha = registrar("alpha").set({ workspaceId: "w1", color: "red" });
    expect(read()).toBe("red");
    alpha.remove();
    expect(read()).toBe("blue");
  });
});
