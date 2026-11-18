import { InternalPluginChild, readInternalPluginExecution } from "./internal-child.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("keeps React out of the plugin host's runtime dependency graph", async () => {
  await expect(
    build({
      entryPoints: [
        fileURLToPath(new URL("./plugin-process.ts", import.meta.url)),
        "@getpaseo/plugin",
        "@getpaseo/plugin/server",
        "@getpaseo/plugin/server/provider",
        "@getpaseo/plugin/server/acp",
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
