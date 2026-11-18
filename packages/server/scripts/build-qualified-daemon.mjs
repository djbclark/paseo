import { build } from "esbuild";
import { builtinModules, createRequire } from "node:module";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const externals = ["node-pty", "sherpa-onnx-node", "onnxruntime-node", "esbuild", "typescript"];
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const banner =
  'import {createRequire as __qualifiedRequire} from "node:module"; import {fileURLToPath as __qualifiedFile} from "node:url"; import {dirname as __qualifiedDirname} from "node:path"; const require=__qualifiedRequire(import.meta.url); const __filename=__qualifiedFile(import.meta.url); const __dirname=__qualifiedDirname(__filename);';
export async function buildQualifiedDaemon({ outDir, distributionBuildId }) {
  if (
    !distributionBuildId ||
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch)
  )
    throw new Error("Finite Linux CI distribution identity required");
  await mkdir(outDir, { recursive: true });
  const allInputs = {};
  const entries = [
    ["daemon-entry", "daemon-entry.mjs", {}],
    ["daemon-launcher", "daemon-launcher.mjs", {}],
    ["cli-entry", "cli-entry.mjs", {}],
    [path.join(packageRoot, "../cli/src/index.ts"), "cli-code.mjs", {}],
    ["daemon-runtime", "daemon.mjs", { __QUALIFIED_DAEMON_ENTRY__: "true" }],
    ["plugin-child-entry", "plugin-child-entry.mjs", {}],
    [
      "plugin-child-runtime",
      "plugin-worker-code.mjs",
      { __QUALIFIED_CHILD_ENTRY__: "true", __PASEO_QUALIFIED_PLUGIN_ENTRY__: "true" },
    ],
    ["compiler-entry", "compiler-entry.mjs", {}],
    ["../plugins/compiler-worker", "compiler-code.mjs", {}],
    ["terminal-entry", "terminal-entry.mjs", {}],
    ["../../terminal/terminal-worker-process", "terminal-code.mjs", {}],
  ];
  for (const [entry, output, define] of entries) {
    const result = await build({
      entryPoints: [
        path.isAbsolute(entry)
          ? entry
          : path.join(packageRoot, "src/server/execution", `${entry}.ts`),
      ],
      outfile: path.join(outDir, output),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: externals,
      metafile: true,
      banner: { js: banner },
      define: { __QUALIFIED_DISTRIBUTION_ID__: JSON.stringify(distributionBuildId), ...define },
      plugins: [
        {
          name: "qualified-no-optional-native-accelerators",
          setup(builder) {
            builder.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (args) => ({
              path: args.path,
              namespace: "qualified-disabled",
            }));
            builder.onLoad({ filter: /.*/, namespace: "qualified-disabled" }, () => ({
              contents: 'throw new Error("Optional native accelerator disabled");',
              loader: "js",
            }));
          },
        },
      ],
      logLevel: "warning",
    });
    for (const emitted of Object.values(result.metafile.outputs))
      for (const imported of emitted.imports) {
        if (
          imported.external &&
          !builtins.has(imported.path) &&
          !externals.some((name) => imported.path === name || imported.path.startsWith(`${name}/`))
        )
          throw new Error(`Unknown qualified daemon external: ${imported.path}`);
      }
    allInputs[output] = result.metafile;
  }
  // Finite installed dependency closure, materialized without workspace symlinks.
  const copied = new Map();
  async function copyPackage(name, fromRequire) {
    let metadataPath;
    try {
      metadataPath = fromRequire.resolve(`${name}/package.json`);
    } catch {
      const entry = fromRequire.resolve(name);
      let current = path.dirname(entry);
      for (;;) {
        try {
          const metadata = JSON.parse(await readFile(path.join(current, "package.json"), "utf8"));
          if (metadata.name === name) {
            metadataPath = path.join(current, "package.json");
            break;
          }
        } catch {}
        if (current === path.dirname(current)) throw new Error(`Missing package root: ${name}`);
        current = path.dirname(current);
      }
    }
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (copied.has(name)) {
      if (copied.get(name) !== metadata.version)
        throw new Error(`Ambiguous qualified dependency: ${name}`);
      return;
    }
    copied.set(name, metadata.version);
    const directory = path.dirname(metadataPath);
    await cp(directory, path.join(outDir, "node_modules", name), {
      recursive: true,
      dereference: true,
      filter: (file) => {
        const relative = path.relative(directory, file);
        return !relative
          .split(path.sep)
          .some((part) => ["node_modules", ".git", ".dev", "test-results"].includes(part));
      },
    });
    const local = createRequire(metadataPath);
    for (const dependency of Object.keys(metadata.dependencies ?? {}))
      await copyPackage(dependency, local);
  }
  for (const name of [
    ...externals,
    "@getpaseo/plugin",
    "@getpaseo/client",
    "@getpaseo/protocol",
    "zod",
    `@esbuild/linux-${process.arch}`,
    `sherpa-onnx-linux-${process.arch}`,
  ])
    await copyPackage(name, require);
  await cp(
    path.join(packageRoot, "src/terminal/shell-integration"),
    path.join(outDir, "shell-integration"),
    { recursive: true },
  );
  await writeFile(
    path.join(outDir, "inputs.json"),
    JSON.stringify({
      schemaVersion: 2,
      distributionBuildId,
      metafiles: allInputs,
      dependencies: Object.fromEntries(copied),
    }),
  );
  await writeFile(
    path.join(outDir, "role.cjs"),
    'import(require("node:url").pathToFileURL(require("node:path").join(__dirname,"daemon-entry.mjs")).href).catch(error=>{console.error(error);process.exitCode=1;});\n',
  );
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [outDir, distributionBuildId] = process.argv.slice(2);
  if (!outDir) throw new Error("output directory required");
  await buildQualifiedDaemon({ outDir: path.resolve(outDir), distributionBuildId });
}
