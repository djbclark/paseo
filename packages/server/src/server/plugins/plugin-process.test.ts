import {
  PluginDirectoryInitializationSchema,
  PluginProcessRequestSchema,
} from "./plugin-process-protocol.js";
import {
  attachPluginWorkerChannel,
  type PluginContributionLoader,
  type PluginWorkerInitializationContext,
} from "./plugin-process.js";
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

/** Exercises the actual exported host port; it does not create producer qualification. */
async function hostLoaderFixture(loader: PluginContributionLoader) {
  const directory = await realpath(await mkdtemp(nodePath.join(tmpdir(), "plugin-host-loader-")));
  const handlers = new Set<(message: PluginProcessRequest) => void>();
  const events: PluginProcessMessage[] = [];
  const ready = deferred();
  const fatal = deferred<string>();
  const cleanup: Array<() => void> = [];
  const dispatch = (message: PluginProcessRequest) => {
    for (const handler of handlers) handler(message);
  };
  const worker = attachPluginWorkerChannel(
    {
      onMessage(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      disconnect() {},
      send(message, callback) {
        events.push(message);
        if (message.type === "ready") ready.resolve();
        if (message.type === "fatal") fatal.resolve(message.error);
        if (message.type === "paseo_frame" && typeof message.data === "string") {
          const frame = JSON.parse(message.data);
          if (frame.type === "hello")
            queueMicrotask(() =>
              dispatch({
                type: "paseo_frame",
                isBinary: false,
                data: JSON.stringify({
                  type: "session",
                  message: {
                    type: "status",
                    payload: {
                      status: "server_info",
                      serverId: "host-loader-test",
                      hostname: "host-loader-test",
                      version: "0.4.0",
                      features: {},
                    },
                  },
                }),
              }),
            );
        }
        callback?.();
      },
    },
    loader,
  );
  const initialize: Extract<PluginProcessRequest, { type: "initialize" }> = {
    type: "initialize",
    pluginId: "original-loader",
    pluginDirectory: directory,
    bundle: "original-loader-bytes",
    appVersion: "0.4.0",
    hostInstanceId: "original-host-instance",
    passiveInitialization: {
      contract: "native-passive-contract-1",
      hold: {
        generation: 4,
        transactionId: "inherited-loader-hold",
        instanceId: "original-host-instance",
      },
    },
  };
  onTestFinished(async () => {
    for (const release of cleanup) release();
    if (worker.activityOwner.state() !== "unknown") await worker.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    worker,
    events,
    initialize,
    dispatch,
    ready: ready.promise,
    fatal: fatal.promise,
    cleanup,
  };
}

it("passes only original frozen worker/activity and immutable initialization to the awaited host loader", async () => {
  const loading = deferred<PluginWorkerInitializationContext>();
  const permitLoad = deferred();
  const contributionCalled = deferred();
  const drain = deferred();
  let continuation:
    | ReturnType<PluginWorkerInitializationContext["activityOwner"]["retainCurrent"]>
    | undefined;
  const host = await hostLoaderFixture(async (source, context) => {
    loading.resolve(context);
    await permitLoad.promise;
    expect(source).toBe("original-loader-bytes");
    expect(context.initialize.pluginId).toBe("original-loader");
    expect(context.initialize.passiveInitialization?.hold?.generation).toBe(4);
    // This continuation still runs on the ORIGINAL no-helper initialization root after await.
    expect(() => spawnProcess(process.execPath, ["-e", "process.exit(0)"])).toThrow(
      "initialization",
    );
    continuation = context.activityOwner.retainCurrent();
    void continuation.run(async () => {
      try {
        await drain.promise;
      } finally {
        continuation?.release();
      }
    });
    return () => {
      contributionCalled.resolve();
      return () => {};
    };
  });
  host.cleanup.push(() => {
    permitLoad.resolve();
    drain.resolve();
  });
  host.dispatch(host.initialize);
  const context = await loading.promise;
  expect(context.workerIdentity).toBe(host.worker);
  expect(context.activityOwner).toBe(host.worker.activityOwner);
  expect(Object.isFrozen(host.worker)).toBe(true);
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.initialize)).toBe(true);
  expect(Object.isFrozen(context.initialize.passiveInitialization?.hold)).toBe(true);
  expect(context.initialize).not.toBe(host.initialize);
  expect(Reflect.set(context.initialize, "pluginId", "candidate-data")).toBe(false);
  if (host.initialize.passiveInitialization?.hold)
    host.initialize.passiveInitialization.hold.generation = 99;
  host.initialize.bundle = "changed-after-dispatch";
  expect(host.events.some((message) => message.type === "ready")).toBe(false);
  expect(host.worker.activityOwner.state()).toBe("known-busy");
  permitLoad.resolve();
  await contributionCalled.promise;
  expect(host.events.some((message) => message.type === "ready")).toBe(false);
  expect(host.worker.activityOwner.state()).toBe("known-busy");
  drain.resolve();
  await host.ready;
  expect(host.worker.activityOwner.state()).toBe("held");
});

it("refuses missing host preparation before contribution without raw evaluator fallback", async () => {
  const refused = deferred();
  const permitRefusal = deferred();
  const host = await hostLoaderFixture(async () => {
    refused.resolve();
    await permitRefusal.promise;
    // Simulates unavailable host preparation, not a producer permission callback.
    throw new Error("selected backend unavailable");
  });
  host.cleanup.push(() => permitRefusal.resolve());
  host.dispatch(host.initialize);
  await refused.promise;
  expect(host.events.some((message) => message.type === "ready")).toBe(false);
  permitRefusal.resolve();
  expect(await host.fatal).toContain("selected backend unavailable");
  expect(host.events.some((message) => message.type === "ready")).toBe(false);
  // No successful/known-held initialization is synthesized from a loader's mere presence.
  expect(host.events.some((message) => message.type === "initialization.rejected")).toBe(false);
});

it("rejects unsupported directory initialization DATA before even calling the host loader", async () => {
  let loads = 0;
  const host = await hostLoaderFixture(() => {
    loads++;
    return () => () => {};
  });
  const unsupported = {
    ...host.initialize,
    directoryInitialization: {
      contract: "ade-directory-helpers-v1",
      activationGeneration: 1,
    },
  };
  host.dispatch(unsupported);
  expect(await host.fatal).toContain("Invalid plugin process request");
  expect(loads).toBe(0);
  expect(host.worker.activityOwner.state()).toBe("unknown");
  expect(host.events.some((message) => message.type === "ready")).toBe(false);
});

it("continues requiring immediate contribution cleanup after async host loading", async () => {
  const { evaluateBundle } = await import("./bundle-evaluator.js");
  const host = await hostLoaderFixture(async () =>
    evaluateBundle("(require) => ({ default: async () => () => {} })"),
  );
  host.dispatch(host.initialize);
  expect(await host.fatal).toContain("Plugin contribution must return a cleanup function");
  expect(host.events.some((message) => message.type === "ready")).toBe(false);
});

it("does not invoke contribution after integrity loss during an actual pending host load", async () => {
  const loading = deferred();
  const continueLoad = deferred();
  let contributed = false;
  const host = await hostLoaderFixture(async () => {
    loading.resolve();
    await continueLoad.promise;
    return () => {
      contributed = true;
      return () => {};
    };
  });
  host.cleanup.push(() => continueLoad.resolve());
  host.dispatch(host.initialize);
  await loading.promise;
  host.worker.activityOwner.markUnknown();
  continueLoad.resolve();
  expect(await host.fatal).toContain("Plugin initialization is unavailable");
  expect(contributed).toBe(false);
  expect(host.worker.activityOwner.state()).toBe("unknown");
  expect(host.events.some((message) => message.type === "ready")).toBe(false);
});

it("keeps existing one-argument synchronous host loaders compatible under passive initialization", async () => {
  let calls = 0;
  const host = await hostLoaderFixture((source) => {
    expect(source).toBe("original-loader-bytes");
    calls++;
    return () => () => {};
  });
  host.dispatch(host.initialize);
  await host.ready;
  expect(calls).toBe(1);
  expect(host.worker.activityOwner.state()).toBe("held");
});

it("keeps actual shutdown waiting for a pending host loader without evaluating its late contribution", async () => {
  const loading = deferred();
  const finishLoad = deferred();
  let contributed = false;
  const host = await hostLoaderFixture(async () => {
    loading.resolve();
    await finishLoad.promise;
    return () => {
      contributed = true;
      return () => {};
    };
  });
  host.cleanup.push(() => finishLoad.resolve());
  host.dispatch(host.initialize);
  await loading.promise;
  let stopped = false;
  const stop = host.worker.shutdown().then(() => {
    stopped = true;
    return undefined;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(host.worker.activityOwner.state()).toBe("known-busy");
  finishLoad.resolve();
  expect(await host.fatal).toContain("Plugin initialization is unavailable");
  await stop;
  expect(contributed).toBe(false);
  expect(host.events.some((message) => message.type === "ready")).toBe(false);
});

function directoryInitializationData() {
  return {
    contract: "ade-directory-helpers-v1" as const,
    activationGeneration: 7,
    operation: "recover" as const,
    profile: {
      version: 1 as const,
      contract: "ade-directory-helpers-v1" as const,
      qualificationSha256: "a".repeat(64),
      runtimeClosureSha256: "b".repeat(64),
      helperClosureSha256: "c".repeat(64),
      moduleTableSha256: "d".repeat(64),
      recipeSha256: "e".repeat(64),
      initialization: "registration-only" as const,
    },
    snapshotRoot: "/immutable/snapshot",
    snapshotSha256: "f".repeat(64),
    hold: { generation: 42, transactionId: "native-reservation", instanceId: "actual-child" },
  };
}

it.each([true, false, undefined])(
  "valid F4 DATA cannot invoke a loader or grant support with managedSource=%s",
  async (managedSource) => {
    let loads = 0;
    const host = await hostLoaderFixture(() => {
      loads++;
      return () => () => {};
    });
    const message = {
      ...host.initialize,
      passiveInitialization: undefined,
      directoryInitialization: directoryInitializationData(),
      managedSource,
    };
    host.dispatch(message);
    expect(await host.fatal).toContain(
      "Qualified ADE directory helper initialization producer unavailable",
    );
    expect(loads).toBe(0);
    expect(
      host.events.some(
        (event) => event.type === "ready" || event.type === "initialization.rejected",
      ),
    ).toBe(false);
    expect(host.worker.activityOwner.state()).toBe("unknown");
  },
);

it("parses only strict F4 DATA, keeping activation ordinal distinct from the existing native hold", () => {
  const original = directoryInitializationData();
  const parsed = PluginDirectoryInitializationSchema.parse(original);
  expect(parsed.activationGeneration).toBe(7);
  expect(parsed.hold?.generation).toBe(42);
  expect(parsed).not.toBe(original);
  expect(parsed.profile).not.toBe(original.profile);
  expect(parsed.hold).not.toBe(original.hold);
  original.profile.recipeSha256 = "0".repeat(64);
  original.hold.generation = 999;
  expect(parsed.profile.recipeSha256).toBe("e".repeat(64));
  expect(parsed.hold?.generation).toBe(42);
  expect(
    PluginDirectoryInitializationSchema.parse({ ...directoryInitializationData(), hold: undefined })
      .hold,
  ).toBeUndefined();
});

it.each([
  { name: "unknown contract", patch: { contract: "other" } },
  { name: "negative ordinal", patch: { activationGeneration: -1 } },
  { name: "fraction ordinal", patch: { activationGeneration: 1.5 } },
  { name: "unsafe ordinal", patch: { activationGeneration: Number.MAX_SAFE_INTEGER + 1 } },
  { name: "unsupported operation", patch: { operation: "verify" } },
  { name: "empty snapshot", patch: { snapshotRoot: "" } },
  { name: "NUL snapshot", patch: { snapshotRoot: "snapshot\0path" } },
  { name: "bad tree digest", patch: { snapshotSha256: "F".repeat(64) } },
  { name: "bearer field", patch: { ownerToken: "must-never-cross-ipc" } },
  { name: "incomplete hold", patch: { hold: { generation: 42, transactionId: "native" } } },
  {
    name: "hold bearer",
    patch: { hold: { ...directoryInitializationData().hold, ownerToken: "not-allowed" } },
  },
  {
    name: "wrong profile",
    patch: {
      profile: { ...directoryInitializationData().profile, contract: "native-passive-contract-1" },
    },
  },
  {
    name: "profile unknown field",
    patch: { profile: { ...directoryInitializationData().profile, allowed: true } },
  },
  {
    name: "profile bad digest",
    patch: { profile: { ...directoryInitializationData().profile, moduleTableSha256: "bad" } },
  },
])("refuses malformed F4 $name without treating syntax as permission", ({ patch }) => {
  expect(
    PluginDirectoryInitializationSchema.safeParse({ ...directoryInitializationData(), ...patch })
      .success,
  ).toBe(false);
});

it("refuses mutually selected initialization profiles and preserves ordinary/passive request shapes", () => {
  const initialize = {
    type: "initialize",
    pluginId: "ordinary",
    pluginDirectory: "/canonical",
    hostInstanceId: "original",
    bundle: "original-bytes",
    appVersion: "0.4.0",
  };
  expect(PluginProcessRequestSchema.safeParse(initialize).success).toBe(true);
  const passive = { contract: "native-passive-contract-1" };
  expect(
    PluginProcessRequestSchema.safeParse({ ...initialize, passiveInitialization: passive }).success,
  ).toBe(true);
  expect(
    PluginProcessRequestSchema.safeParse({
      ...initialize,
      directoryInitialization: directoryInitializationData(),
    }).success,
  ).toBe(true);
  expect(
    PluginProcessRequestSchema.safeParse({
      ...initialize,
      passiveInitialization: passive,
      directoryInitialization: directoryInitializationData(),
    }).success,
  ).toBe(false);
});

// The entry basename selects diagnostics only; it never creates producer qualification.
async function startupMarkerFixture(mode: string, entryName = "role.cjs") {
  const directory = await realpath(await mkdtemp(nodePath.join(tmpdir(), "plugin-phase-markers-")));
  const workerModule = fileURLToPath(
    new URL("../../../dist/server/server/plugins/plugin-process.js", import.meta.url),
  );
  const entry = nodePath.join(directory, entryName);
  await writeFile(
    entry,
    `
    const { pathToFileURL } = require('node:url');
    async function main() {
      const { attachPluginWorkerChannel } = await import(pathToFileURL(${JSON.stringify(workerModule)}).href);
      const mode = ${JSON.stringify(mode)};
      const directory = ${JSON.stringify(directory)};
      const messages = [];
      let receive;
      let resolveReady, resolveFatal, resolveContributed, releaseDrain;
      const ready = new Promise(resolve => { resolveReady = resolve; });
      const fatal = new Promise(resolve => { resolveFatal = resolve; });
      const contributed = new Promise(resolve => { resolveContributed = resolve; });
      const drain = new Promise(resolve => { releaseDrain = resolve; });
      let readyBeforeDrain = null;
      const channel = {
        onMessage(handler) { receive = handler; return () => {}; }, disconnect() {},
        send(message, callback) {
          messages.push(message.type);
          if (message.type === 'ready') resolveReady();
          if (message.type === 'fatal') resolveFatal(message.error);
          if (message.type === 'paseo_frame' && typeof message.data === 'string' && JSON.parse(message.data).type === 'hello') {
            queueMicrotask(() => receive({ type: 'paseo_frame', isBinary: false, data: JSON.stringify({
              type: 'session', message: { type: 'status', payload: { status: 'server_info',
              serverId: 'phase-test', hostname: 'phase-test', version: '0.4.0', features: {} } }
            }) }));
          }
          callback?.();
        }
      };
      const worker = attachPluginWorkerChannel(channel, async (_source, original) => {
        if (mode === 'loader-error') throw new Error('original loader rejection');
        if (mode === 'drain') {
          const continuation = original.activityOwner.retainCurrent();
          void continuation.run(async () => { try { await drain; } finally { continuation.release(); } });
        }
        return () => {
          if (mode === 'contribution-error') throw new Error('original contribution rejection');
          resolveContributed();
          return () => {};
        };
      });
      receive({ type: 'initialize', pluginId: 'phase-test', pluginDirectory: directory,
        appVersion: '0.4.0', bundle: 'host-loader-bytes', hostInstanceId: 'phase-instance',
        passiveInitialization: { contract: 'native-passive-contract-1', hold: {
          generation: 1, transactionId: 'phase-test', instanceId: 'phase-instance' } } });
      if (mode === 'drain') {
        await contributed;
        await new Promise(resolve => setImmediate(resolve));
        readyBeforeDrain = messages.includes('ready');
        releaseDrain();
      }
      const outcome = await Promise.race([ready.then(() => ({ ready: true })), fatal.then(error => ({ error }))]);
      await worker.shutdown();
      process.stdout.write(JSON.stringify({ outcome, readyBeforeDrain, messages }));
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });
  `,
  );
  try {
    const result = await promisify(execFile)(process.execPath, [entry], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const rows = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("PASEO_STARTUP_PHASE "))
      .map((line) => JSON.parse(line.slice("PASEO_STARTUP_PHASE ".length)));
    return { result: JSON.parse(result.stdout), rows };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("records actual original worker startup boundaries while retained init work drains before ready", async () => {
  const { result, rows } = await startupMarkerFixture("drain");
  expect(result.outcome).toEqual({ ready: true });
  expect(result.readyBeforeDrain).toBe(false);
  expect(rows.map((row) => [row.phase, row.edge])).toEqual([
    ["worker.initialize-received", "point"],
    ["worker.connect", "begin"],
    ["worker.connect", "end"],
    ["worker.load", "begin"],
    ["worker.load", "end"],
    ["worker.contribute", "begin"],
    ["worker.contribute", "end"],
    ["worker.usage-metadata", "begin"],
    ["worker.usage-metadata", "end"],
    ["worker.init-drain", "begin"],
    ["worker.init-drain", "end"],
    ["worker.ready-send", "point"],
  ]);
  const pid = rows[0].pid;
  for (const [index, row] of rows.entries()) {
    expect(row).toMatchObject({ version: 1, pid, role: "daemon", seq: index + 1 });
    if (row.edge === "end")
      expect(row).toMatchObject({ outcome: "ok", durationUs: expect.any(Number) });
    expect(
      Buffer.byteLength("PASEO_STARTUP_PHASE " + JSON.stringify(row) + "\n"),
    ).toBeLessThanOrEqual(256);
  }
});

it.each(["loader-error", "contribution-error"])(
  "preserves %s without a false successful span or ready marker",
  async (mode) => {
    const { result, rows } = await startupMarkerFixture(mode);
    expect(result.outcome).toEqual({
      error:
        mode === "loader-error" ? "original loader rejection" : "original contribution rejection",
    });
    expect(result.messages).not.toContain("ready");
    const phase = mode === "loader-error" ? "worker.load" : "worker.contribute";
    expect(rows.filter((row) => row.phase === phase).map((row) => row.edge)).toEqual(["begin"]);
    expect(rows.some((row) => row.phase === "worker.ready-send")).toBe(false);
    expect(rows.some((row) => row.phase === "worker.init-drain" && row.edge === "end")).toBe(false);
  },
);

it("leaves ordinary unknown-entry worker behavior and stdout intact without diagnostic output", async () => {
  const { result, rows } = await startupMarkerFixture("success", "ordinary.cjs");
  expect(result.outcome).toEqual({ ready: true });
  expect(rows).toEqual([]);
});
