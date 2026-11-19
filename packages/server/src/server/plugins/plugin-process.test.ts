import { spawnProcess } from "@getpaseo/plugin/server";
import type { ChildProcess } from "node:child_process";
import { MaintenanceReservation } from "../maintenance-reservation.js";
import { PluginExecutionOwner } from "./execution-owner.js";
import type { PluginExecutionRoot } from "./execution-roots.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { defineRpc, defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { InternalPluginChild, readInternalPluginExecution } from "./internal-child.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it, onTestFinished, vi } from "vitest";

it("keeps React out of the plugin host's runtime dependency graph", async () => {
  await expect(
    build({
      entryPoints: [
        fileURLToPath(new URL("./plugin-process.ts", import.meta.url)),
        "@getpaseo/plugin",
        "@getpaseo/plugin/server",
        "@getpaseo/plugin/server/provider",
        "@getpaseo/plugin/server/acp",
        "@getpaseo/plugin/server/ade-helpers",
      ],
      outdir: "unused",
      conditions: ["source"],
      bundle: true,
      platform: "node",
      format: "esm",
      // Node evaluates re-exports even when the host only imports one helper.
      treeShaking: false,
      write: false,
      logLevel: "silent",
      plugins: [
        {
          name: "no-react",
          setup(context) {
            context.onResolve(
              { filter: /^(react|react-dom|react-native|use-sync-external-store)(\/|$)/ },
              ({ path, importer }) => ({
                errors: [{ text: `React dependency ${path} imported by ${importer}` }],
              }),
            );
          },
        },
      ],
    }),
  ).resolves.toMatchObject({ errors: [] });
});

it("exposes CLI probes through the plugin host's server SDK", async () => {
  const { evaluateBundle } = await import("./bundle-evaluator.js");
  const setup = evaluateBundle(`(require) => ({ default: async () => {
    const { execCommand } = require("@getpaseo/plugin/server");
    const { stdout } = await execCommand(${JSON.stringify(process.execPath)}, ["-e", "process.stdout.write('plugin CLI ready')"]);
    if (stdout !== "plugin CLI ready") throw new Error("CLI output was lost");
  } })`);
  // This contribution uses no server context APIs; it exercises the host's real SDK binding.
  await expect(setup(undefined as never)).resolves.toBeUndefined();
});

it("keeps the sealed worker import inert until the producer calls the exported initializer", async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), "paseo-sealed-worker-entry-"));
  try {
    const source = fileURLToPath(new URL("./plugin-process.ts", import.meta.url));
    const result = await build({
      stdin: {
        contents: `import { attachPluginWorkerChannel } from ${JSON.stringify(source)};
        if (typeof attachPluginWorkerChannel !== 'function') throw new Error('missing initializer');
        if (process.listenerCount('message') !== 0) throw new Error('legacy entry wired before producer');
        process.stdout.write('sealed-entry-inert');`,
        resolveDir: nodePath.dirname(source),
        sourcefile: "qualified-worker-fixture.ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      conditions: ["source"],
      write: false,
      logLevel: "silent",
      define: { __PASEO_QUALIFIED_PLUGIN_ENTRY__: "true" },
      banner: {
        js: "import { createRequire as qualifiedFixtureRequire } from 'node:module'; const require = qualifiedFixtureRequire(import.meta.url);",
      },
    });
    const entry = nodePath.join(root, "plugin-child.mjs");
    const output = result.outputFiles?.[0];
    if (!output) throw new Error("Missing sealed-entry fixture output");
    await writeFile(entry, output.contents);
    const { stdout } = await promisify(execFile)(process.execPath, [entry], {
      env: { PATH: process.env.PATH },
    });
    expect(stdout).toBe("sealed-entry-inert");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("exposes only the original internal worker/activity association before any contribution evaluation", async () => {
  let evaluated = false;
  const child = new InternalPluginChild(() => {
    evaluated = true;
    return () => () => {};
  });
  const binding = readInternalPluginExecution(child);
  expect(binding).toBeDefined();
  expect(binding).toBe(readInternalPluginExecution(child));
  expect(Object.isFrozen(binding)).toBe(true);
  expect(evaluated).toBe(false);
  expect(readInternalPluginExecution(Object.create(InternalPluginChild.prototype))).toBeUndefined();
  expect(
    readInternalPluginExecution({
      workerIdentity: binding?.workerIdentity,
      activityOwner: binding?.activityOwner,
    }),
  ).toBeUndefined();
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.disconnect();
  await closed;
});

it("does not acknowledge internal child closure after uncertain actual worker retirement", async () => {
  const child = new InternalPluginChild(() => () => () => {});
  const execution = readInternalPluginExecution(child);
  if (!execution) throw new Error("Missing original execution binding");
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  execution.activityOwner.markUnknown();
  await expect(child.retire()).rejects.toThrow("retirement is uncertain");
  expect(closed).toBe(false);
  expect(child.connected).toBe(true);
});

it.each([
  {
    name: "fixed registration validation with valid cleanup",
    outcome: "initialization.rejected",
    bundle: `(require) => { const {z} = require("zod"); return {default: context => {
    context.handle({name:"InvalidMethod",input:z.unknown(),output:z.unknown()},()=>null);
    return ()=>{};
  }}; }`,
  },
  { name: "malformed cleanup", outcome: "fatal", bundle: "(require) => ({default:()=>undefined})" },
  {
    name: "arbitrary candidate throw",
    outcome: "fatal",
    bundle: "(require) => ({default:()=>{throw new Error('candidate throw')}})",
  },
])("separates $name from actual settled retirement", async ({ bundle, outcome }) => {
  const root = await realpath(await mkdtemp(nodePath.join(tmpdir(), "plugin-init-rejection-")));
  const { evaluateBundle } = await import("./bundle-evaluator.js");
  const child = new InternalPluginChild(evaluateBundle);
  const events: string[] = [];
  const identity = { generation: 7, transactionId: "sdk-unit", instanceId: "actual-sdk-instance" };
  const rejected = new Promise<string>((resolve) =>
    child.on("message", (message) => {
      events.push(message.type);
      if (message.type === "paseo_frame" && typeof message.data === "string") {
        const frame = JSON.parse(message.data);
        if (frame.type === "hello")
          child.send({
            type: "paseo_frame",
            isBinary: false,
            data: JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "sdk-unit",
                  hostname: "sdk-unit",
                  version: "0.4.0",
                  features: {},
                },
              },
            }),
          });
      }
      if (message.type === "initialization.rejected" || message.type === "fatal")
        resolve(message.type);
    }),
  );
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      events.push("close");
      resolve();
    }),
  );
  try {
    // SDK transport/state proof only. No genuine producer owner or qualification is minted.
    child.send({
      type: "initialize",
      pluginId: "rejected",
      pluginDirectory: root,
      hostInstanceId: identity.instanceId,
      appVersion: "0.4.0",
      bundle,
      passiveInitialization: { contract: "native-passive-contract-1", hold: identity },
    });
    expect(await rejected).toBe(outcome);
    if (outcome === "fatal") {
      expect(events).not.toContain("initialization.rejected");
      expect(events).not.toContain("initialization.retired");
      await child.retire();
      return;
    }
    expect(child.connected).toBe(true);
    child.send({ type: "initialization.retire", requestId: "retire", ...identity });
    await closed;
    expect(events.indexOf("initialization.retired")).toBeGreaterThan(
      events.indexOf("initialization.rejected"),
    );
    expect(events.indexOf("close")).toBeGreaterThan(events.indexOf("initialization.retired"));
    expect(events).not.toContain("ready");
    expect(events).not.toContain("fatal");
  } finally {
    if (child.connected) await child.retire();
    await rm(root, { recursive: true, force: true });
  }
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Real worker + parent execution owner + native leases. No producer qualification is minted. */
async function settingsExecutionFixture(contribute: PluginServerContribution, saved?: object) {
  const root = await realpath(await mkdtemp(nodePath.join(tmpdir(), "settings-activity-")));
  const settingsDirectory = nodePath.join(root, "settings");
  await (await import("node:fs/promises")).mkdir(settingsDirectory);
  if (saved)
    await writeFile(nodePath.join(settingsDirectory, "display.json"), JSON.stringify(saved));
  const child = new InternalPluginChild(() => contribute);
  const execution = readInternalPluginExecution(child);
  if (!execution) throw new Error("Missing original worker");
  const native = await MaintenanceReservation.create(root, async () => true);
  native.setReady(true);
  const owner = new PluginExecutionOwner(
    "settings-instance",
    {
      enterWork: () => native.enter(),
      runAdmittedWork: (lease, operation) => native.executeAdmitted(lease, operation),
      holdForUnknownWork: () => native.holdForUnknownWork(),
      runQualifiedInitialization: (operation) => native.runQualifiedInitialization(operation),
    },
    () => native.status().state !== "idle",
    () => {},
  );
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const ready = deferred();
  let sequence = 0;
  child.on("message", (message: PluginProcessMessage) => {
    if (message.type === "execution.settled") owner.settled(message.instanceId, message.requestKey);
    if (message.type === "execution.unknown") owner.markUnknown();
    if (message.type === "ready") ready.resolve();
    if (message.type === "fatal") ready.reject(new Error(message.error));
    if (message.type === "result" || message.type === "error") {
      const awaitingReply = pending.get(message.requestId);
      pending.delete(message.requestId);
      if (message.type === "error") awaitingReply?.reject(new Error(message.error));
      else awaitingReply?.resolve(message.output);
    }
    if (message.type === "paseo_frame" && typeof message.data === "string") {
      const frame = JSON.parse(message.data);
      if (frame.type === "hello")
        child.send({
          type: "paseo_frame",
          isBinary: false,
          data: JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "settings-test",
                hostname: "settings-test",
                version: "0.4.0",
                features: {},
              },
            },
          }),
        });
    }
  });
  function request(
    message: Extract<PluginProcessRequest, { requestId: string }>,
    rootWork = false,
  ) {
    const result = new Promise<unknown>((resolve, reject) =>
      pending.set(message.requestId, { resolve, reject }),
    );
    if (rootWork) {
      const rootMessage = message as PluginExecutionRoot;
      try {
        owner.admit(rootMessage);
        owner.runAdmitted(rootMessage, () => child.send(message));
      } catch (error) {
        pending.delete(message.requestId);
        return Promise.reject(error);
      }
    } else child.send(message);
    return result;
  }
  const identity = { generation: 1, transactionId: "settings-barrier" };
  const barrier = (type: "maintenance.begin" | "maintenance.end") =>
    request({
      type,
      requestId: `barrier-${++sequence}`,
      instanceId: "settings-instance",
      ...identity,
    });
  onTestFinished(async () => {
    // Cleanup is not a maintenance quiet proof; unknown workers cannot acknowledge retirement.
    if (execution.activityOwner.state() !== "unknown") await child.retire();
    await native.flushStorage();
    await rm(root, { recursive: true, force: true });
  });
  child.send({
    type: "initialize",
    pluginId: "settings-test",
    pluginDirectory: root,
    hostInstanceId: "settings-instance",
    settingsDirectory,
    appVersion: "0.4.0",
    bundle: "",
    passiveInitialization: { contract: "native-passive-contract-1" },
  });
  return {
    child,
    execution,
    native,
    owner,
    ready: ready.promise,
    settingsDirectory,
    barrier,
    invoke: (method: string, input: unknown = {}) =>
      request(
        {
          type: "invoke",
          requestId: `invoke-${++sequence}`,
          method,
          input,
        },
        true,
      ),
    idle: async () => {
      await expect.poll(() => owner.busy()).toBe(false);
    },
  };
}

const activitySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({ count: z.number().default(0) }),
});
const displayRpc = settingsRpc("display");
const probeRpc = defineRpc({ name: "settings.probe", input: z.object({}), output: z.json() });

it("idle subscriptions do not retain initialization, and producer callbacks keep real native leases past replies/unsubscribe", async () => {
  const started = deferred();
  const drain = deferred();
  let unsubscribe = () => {};
  let observations = 0;
  const fixture = await settingsExecutionFixture((context) => {
    const settings = context.registerSettings(activitySettings);
    unsubscribe = settings.subscribe(async () => {
      observations++;
      started.resolve();
      await drain.promise;
      // Still the actual producing root, even after a provisional child barrier.
      await settings.read();
    });
    return unsubscribe;
  });
  await fixture.ready;
  expect(fixture.execution.activityOwner.state()).toBe("held");
  expect(fixture.owner.busy()).toBe(false);
  const saved = await fixture.invoke(displayRpc.write.name, {
    revision: "missing",
    values: { count: 1 },
  });
  expect(saved).toMatchObject({ status: "saved" });
  await started.promise;
  unsubscribe();
  expect(fixture.owner.busy()).toBe(true);
  await expect(fixture.native.begin(1, "non-target-promotion")).rejects.toThrow("refused");
  expect(await fixture.barrier("maintenance.begin")).toMatchObject({ status: "known-busy" });
  drain.resolve();
  await fixture.idle();
  expect(fixture.execution.activityOwner.state()).toBe("held");
  expect(observations).toBe(1);
  await fixture.barrier("maintenance.end");
  const current = displayRpc.read.output.parse(await fixture.invoke(displayRpc.read.name));
  await fixture.invoke(displayRpc.write.name, { revision: current.revision, values: { count: 2 } });
  await fixture.idle();
  expect(observations).toBe(1);
});

it("overlapping producers and nested reads/writes preserve the live listener set without serial callback deadlock", async () => {
  const entered = deferred();
  const firstDrain = deferred();
  const secondDrain = deferred();
  const counts: number[] = [];
  let removeLater = () => {};
  const fixture = await settingsExecutionFixture((context) => {
    const settings = context.registerSettings(activitySettings);
    settings.subscribe(async (state) => {
      if (state.status !== "ready") return;
      counts.push(state.values.count);
      removeLater();
      if (state.values.count === 1) {
        // Await another queued write from an actual callback. Store queue must not await us.
        const current = await settings.read();
        if (current.status !== "ready") throw new Error("Missing ready state");
        await contextReadWrite(current.revision);
        entered.resolve();
        await firstDrain.promise;
      } else await secondDrain.promise;
    });
    removeLater = settings.subscribe(() => {
      throw new Error("Removed before live-set visit");
    });
    return removeLater;
  });
  async function contextReadWrite(revision: string) {
    return fixture.invoke(displayRpc.write.name, { revision, values: { count: 2 } });
  }
  await fixture.ready;
  await fixture.invoke(displayRpc.write.name, { revision: "missing", values: { count: 1 } });
  await entered.promise;
  expect(counts).toEqual([1, 2]);
  expect(fixture.owner.busy()).toBe(true);
  secondDrain.resolve();
  await expect.poll(() => fixture.execution.activityOwner.state()).toBe("known-busy");
  expect(fixture.owner.busy()).toBe(true);
  firstDrain.resolve();
  await fixture.idle();
});

it("does not send ready before an actual initialization migration notification drains", async () => {
  const started = deferred();
  const drain = deferred();
  let initializationRead: Promise<unknown> | undefined;
  const fixture = await settingsExecutionFixture(
    (context) => {
      const settings = context.registerSettings({
        ...activitySettings,
        version: 2,
        migrate: (previous) => previous,
      });
      settings.subscribe(async () => {
        started.resolve();
        await drain.promise;
      });
      initializationRead = settings.read();
      return () => {};
    },
    { version: 1, values: { count: 3 } },
  );
  let ready = false;
  void fixture.ready.then(() => {
    ready = true;
    return undefined;
  });
  await started.promise;
  await initializationRead;
  expect(ready).toBe(false);
  expect(fixture.execution.activityOwner.state()).toBe("known-busy");
  drain.resolve();
  await fixture.ready;
  expect(fixture.execution.activityOwner.state()).toBe("held");
});

it("preserves ordinary rejected callback semantics after actual drain, while lost execution identity latches UNKNOWN", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errorLog.mockRestore());
  const fixture = await settingsExecutionFixture((context) => {
    const settings = context.registerSettings(activitySettings);
    settings.subscribe(async () => {
      throw new Error("ordinary callback failure");
    });
    context.handle(probeRpc, () => null);
    return () => {};
  });
  await fixture.ready;
  await fixture.invoke(displayRpc.write.name, { revision: "missing", values: { count: 1 } });
  await fixture.idle();
  expect(fixture.execution.activityOwner.state()).toBe("held");
  expect(fixture.native.status().recoveryRequired).toBe(false);
  expect(errorLog).toHaveBeenCalled();
  fixture.owner.settled("wrong-instance", "missing-root");
  expect(fixture.native.status().recoveryRequired).toBe(true);
  await expect(fixture.invoke(probeRpc.name)).rejects.toThrow("admission");
});

it("retains queued producers after caller timeout and refuses new work when BEGIN wins", async () => {
  const migrating = deferred();
  const allowMigration = deferred();
  const callerTimeout = deferred();
  const notifications: number[] = [];
  const fixture = await settingsExecutionFixture(
    (context) => {
      const settings = context.registerSettings({
        ...activitySettings,
        version: 2,
        migrate: async (previous) => {
          migrating.resolve();
          await allowMigration.promise;
          return previous;
        },
      });
      settings.subscribe((state) => {
        if (state.status === "ready") notifications.push(state.values.count);
      });
      return () => {};
    },
    { version: 1, values: { count: 4 } },
  );
  await fixture.ready;
  const producerRead = fixture.invoke(displayRpc.read.name);
  await migrating.promise;
  const queuedRead = fixture.invoke(displayRpc.read.name);
  const timedCaller = Promise.race([
    queuedRead,
    callerTimeout.promise.then(() => {
      throw new Error("caller timeout");
    }),
  ]);
  callerTimeout.resolve();
  await expect(timedCaller).rejects.toThrow("caller timeout");
  await expect(fixture.native.begin(1, "queued-producer")).rejects.toThrow("refused");
  expect(fixture.owner.busy()).toBe(true);
  allowMigration.resolve();
  await Promise.all([producerRead, queuedRead]);
  await fixture.idle();
  expect(notifications).toEqual([4]);
  const held = await fixture.native.begin(1, "held-before-settings");
  expect(held.state).toBe("held");
  await expect(
    fixture.invoke(displayRpc.write.name, { revision: "missing", values: { count: 9 } }),
  ).rejects.toThrow("admission");
  await fixture.idle();
  expect(notifications).toEqual([4]);
  expect(
    JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(nodePath.join(fixture.settingsDirectory, "display.json"), "utf8"),
    ),
  ).toMatchObject({ values: { count: 4 } });
  await fixture.native.end(1, held.ownerToken);
});

it("does not release the callback's actual helper lifetime when its listener and RPC have already returned", async () => {
  const launched = deferred();
  let helper: ChildProcess | undefined;
  const fixture = await settingsExecutionFixture((context) => {
    const settings = context.registerSettings(activitySettings);
    settings.subscribe(() => {
      helper = spawnProcess(process.execPath, ["-e", "process.stdin.resume()"], { stdio: "pipe" });
      launched.resolve();
    });
    return () => {
      helper?.stdin?.end();
    };
  });
  await fixture.ready;
  await fixture.invoke(displayRpc.write.name, { revision: "missing", values: { count: 1 } });
  await launched.promise;
  expect(fixture.owner.busy()).toBe(true);
  await expect(fixture.native.begin(1, "helper-active")).rejects.toThrow("refused");
  const closed = new Promise<void>((resolve) => helper?.once("close", () => resolve()));
  helper?.stdin?.end();
  await closed;
  await fixture.idle();
  expect(fixture.execution.activityOwner.state()).toBe("held");
});
