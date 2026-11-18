import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
