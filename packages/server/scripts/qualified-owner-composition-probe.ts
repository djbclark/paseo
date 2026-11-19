// Fixed CI fixture entry, compiled as daemon.mjs in a separately inventoried
// retained root. The production daemon entry never imports this file. No verifier
// is replaced and no test boolean/JSON creates an owner or SDK root.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getQualifiedDaemonOwner,
  isQualifiedDaemonOwner,
  readQualifiedBuiltinContext,
} from "../src/server/execution/daemon-owner.js";
import {
  createQualifiedBuiltinInstance,
  assertQualifiedBuiltinInstance,
} from "../src/server/execution/builtin-instance.js";
import { builtinRuntimeRequire, builtinGlobals } from "../src/server/execution/builtin-bindings.js";
import {
  observeBuiltinGitPhases,
  type BuiltinGitObservationPhase,
} from "../src/server/execution/builtin-git-observation.js";
import { readInternalPluginExecution } from "../src/server/plugins/internal-child.js";
import type { PluginServerContribution, PluginServerContext } from "@getpaseo/plugin/server";

export async function startQualifiedDaemon(): Promise<void> {
  const owner = await getQualifiedDaemonOwner();
  const fixture = await createQualifiedBuiltinInstance(owner, "worktree-include");
  const execution = readInternalPluginExecution(fixture.child);
  assert.ok(execution);
  const activity = execution.activityOwner;
  const request = await new Promise<{ phase: BuiltinGitObservationPhase; revoke: boolean }>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixed fixture case missing")), 5000);
      const receive = (value: unknown) => {
        if (!value || typeof value !== "object" || Reflect.get(value, "type") !== "fixture.case")
          return;
        assert.deepEqual(Object.keys(value).sort(), ["phase", "revoke", "type"]);
        const phase = Reflect.get(value, "phase"),
          revoke = Reflect.get(value, "revoke");
        assert.ok(["preflight", "ready", "settlement"].includes(phase));
        assert.equal(typeof revoke, "boolean");
        clearTimeout(timer);
        process.off("message", receive);
        resolve({ phase, revoke });
      };
      process.on("message", receive);
      process.send?.({ type: "fixture.awaiting-case" });
    },
  );
  const profile = readQualifiedBuiltinContext(owner).profiles?.find(
    (row) => row.id === "worktree-include",
  )?.finiteGit;
  assert.ok(profile);
  const settings = {
    ...request,
    source: profile.recipe.repository.cwd,
    destination: path.join(
      process.env.PASEO_HOME!,
      "owner-composition",
      request.phase,
      request.revoke ? "revoked" : "valid",
    ),
  };
  let hook:
    | ((input: { worktree: { path: string; sourceCheckout: string } }) => Promise<void>)
    | undefined;
  const initialization = activity.initialization();
  try {
    initialization.run(() => {
      const factory: unknown = (0, eval)(fixture.serverBundle);
      assert.equal(typeof factory, "function");
      const exports = (
        factory as (
          require: typeof builtinRuntimeRequire,
          globals: typeof builtinGlobals,
        ) => { default: PluginServerContribution }
      )(builtinRuntimeRequire, builtinGlobals);
      const unavailable = (): never => {
        throw new Error("Unexpected fixture host operation");
      };
      const context: PluginServerContext = {
        sourceDirectory: path.join(owner.root, "builtin-plugins/worktree-include"),
        managedSource: false,
        handle: unavailable,
        registerProvider: unavailable,
        registerUsageSource: unavailable,
        registerSettings: unavailable,
        on: unavailable,
        before: unavailable,
        addHook(name, handler) {
          assert.equal(name, "worktree.create.after");
          hook = async (input) => {
            await Reflect.apply(handler, undefined, [input]);
          };
          return () => {};
        },
      };
      exports.default(context);
    });
  } finally {
    initialization.release();
  }
  assert.ok(hook);
  let triggered = false;
  const refreshes: Promise<void>[] = [];
  const stop = observeBuiltinGitPhases(fixture.child, owner, (phase) => {
    if (triggered || phase !== settings.phase) return;
    triggered = true;
    const refresh = owner.refresh();
    refreshes.push(refresh.catch(() => undefined));
    assert.throws(() => owner.assertFresh());
    assert.equal(isQualifiedDaemonOwner(owner), false);
    if (!settings.revoke) return; // Never await a refresh which may await observed.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Fixture revocation acknowledgement missing")),
        1500,
      );
      const receive = (value: unknown) => {
        if (!value || typeof value !== "object" || Reflect.get(value, "type") !== "fixture.revoked")
          return;
        clearTimeout(timer);
        process.off("message", receive);
        resolve();
      };
      process.on("message", receive);
      process.send?.({ type: "fixture.revoke" });
    });
  });
  const root = activity.acquire();
  let failure: unknown;
  try {
    await root.run(() =>
      hook!({ worktree: { path: settings.destination, sourceCheckout: settings.source } }),
    );
    if (!settings.revoke) assert.equal(activity.state(), "known-busy");
  } catch (error) {
    failure = error;
  } finally {
    root.release();
    stop();
  }
  await Promise.all(refreshes);
  assert.equal(triggered, true, "Actual qualified Git path never reached selected phase");
  if (settings.revoke) {
    assert.equal(activity.state(), "unknown");
    assert.throws(() => assertQualifiedBuiltinInstance(fixture.child, owner, "worktree-include"));
  } else {
    if (failure) throw failure;
    const cleanup = activity.retirementCleanup();
    cleanup.release();
    await activity.waitForRetirement();
    owner.assertFresh();
    assertQualifiedBuiltinInstance(fixture.child, owner, "worktree-include");
    assert.equal(activity.state(), "held");
    for (const name of ["external.txt", "local.txt"])
      assert.equal(await readFile(path.join(settings.destination, name), "utf8"), name);
  }
  process.send?.({
    type: "fixture.result",
    phase: settings.phase,
    revoke: settings.revoke,
    state: activity.state(),
    qualification: false,
  });
  process.disconnect?.();
}
