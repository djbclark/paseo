import { describe, expect, it, vi } from "vitest";
import { PluginExecutionOwner } from "./execution-owner.js";
import type { NativePluginAdmission } from "./maintenance.js";

function fixture() {
  const release = vi.fn();
  const native: NativePluginAdmission = {
    enterWork: vi.fn(() => release),
    holdForUnknownWork: vi.fn(),
    runQualifiedInitialization: async (operation) => operation(),
  };
  let closed = false;
  const unknown = vi.fn();
  const owner = new PluginExecutionOwner("instance", native, () => closed, unknown);
  return {
    owner,
    native,
    release,
    unknown,
    close: () => {
      closed = true;
    },
  };
}

describe("plugin execution ownership independent of reply correlation", () => {
  it("retains work through caller timeout/abort until matching actual execution settlement", () => {
    const { owner, native, release } = fixture();
    owner.admit({ type: "invoke", requestId: "request", method: "test", input: null });
    expect(native.enterWork).toHaveBeenCalledOnce();
    // Neither a result, an abort request, nor deleting a pending RPC owns this lease.
    expect(owner.busy()).toBe(true);
    expect(release).not.toHaveBeenCalled();
    owner.settled("instance", "request");
    expect(owner.busy()).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    owner.settled("instance", "request");
    expect(release).toHaveBeenCalledOnce();
  });
  it("closes new dispatch before native admission while leaving admitted roots intact", () => {
    const { owner, native, release, close } = fixture();
    owner.admit({ type: "invoke", requestId: "first", method: "test", input: null });
    close();
    expect(() =>
      owner.admit({ type: "invoke", requestId: "second", method: "test", input: null }),
    ).toThrow("admission is closed");
    expect(native.enterWork).toHaveBeenCalledOnce();
    expect(owner.busy()).toBe(true);
    expect(release).not.toHaveBeenCalled();
    owner.settled("instance", "first");
    expect(release).toHaveBeenCalledOnce();
  });
  it("wrong incarnation and child close with unfinished work hold rather than release", () => {
    const { owner, native, release, unknown } = fixture();
    owner.admit({ type: "invoke", requestId: "request", method: "test", input: null });
    owner.settled("different-instance", "request");
    expect(native.holdForUnknownWork).toHaveBeenCalledOnce();
    expect(unknown).toHaveBeenCalledOnce();
    owner.terminated();
    expect(native.holdForUnknownWork).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    expect(owner.busy()).toBe(true);
  });
});

it("cannot authorize held child termination using a fabricated reservation scope", () => {
  const { owner, close, native } = fixture();
  const held = {
    claim: {
      generation: 1,
      transactionId: "forged",
      operation: "replace" as const,
      pluginId: "probe",
      path: "/new",
      expectedPath: "/old",
      expectedGeneration: 1,
      snapshotSha256: "a".repeat(64),
      serverBundleSha256: "b".repeat(64),
    },
    scope: {} as import("../maintenance-operation.js").HeldPluginOperationScope,
  };
  expect(() => owner.expectHeldTermination(held, "instance")).toThrow();
  close();
  owner.terminated();
  expect(native.holdForUnknownWork).toHaveBeenCalledOnce();
});
