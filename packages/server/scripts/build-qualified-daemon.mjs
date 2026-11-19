import { build, version as esbuildVersion } from "esbuild";
import { createHash } from "node:crypto";
import { isBuiltin, createRequire } from "node:module";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildQualifiedGit } from "./build-qualified-git.mjs";
import { retainBuiltinPlugins } from "./qualified-builtin-sources.mjs";
import { precompileBuiltinPlugins } from "./build-qualified-builtins.mjs";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../..");
const digest = (data) => createHash("sha256").update(data).digest("hex");
function inputName(file) {
  if (file.startsWith("qualified-disabled:")) return file;
  const relative = path.relative(repositoryRoot, path.resolve(repositoryRoot, file));
  if (path.isAbsolute(relative) || relative.split(path.sep).includes(".."))
    throw new Error("Input outside finite source tree");
  return relative.split(path.sep).join("/");
}
function inputMetafile(meta, output) {
  const inputs = Object.fromEntries(
    Object.entries(meta.inputs).map(([name, value]) => [
      inputName(name),
      {
        ...value,
        imports: value.imports.map((row) => ({
          ...row,
          path: row.external ? row.path : inputName(row.path),
        })),
      },
    ]),
  );
  const outputs = Object.fromEntries(
    Object.values(meta.outputs).map((value) => [
      output,
      {
        ...value,
        entryPoint: inputName(value.entryPoint),
        inputs: Object.fromEntries(
          Object.entries(value.inputs).map(([key, row]) => [inputName(key), row]),
        ),
      },
    ]),
  );
  return { inputs, outputs };
}
const require = createRequire(import.meta.url);
const externals = ["node-pty", "sherpa-onnx-node", "esbuild", "typescript"];
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
    [path.join(packageRoot, "scripts/qualified-public-client.mjs"), "client-code.mjs", {}],
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
      absWorkingDir: repositoryRoot,
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
      define: {
        __PASEO_QUALIFIED_PLUGIN_ENTRY__: "true",
        __QUALIFIED_DISTRIBUTION_ID__: JSON.stringify(distributionBuildId),
        ...define,
      },
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
          !isBuiltin(imported.path) &&
          !externals.some((name) => imported.path === name || imported.path.startsWith(`${name}/`))
        )
          throw new Error(`Unknown qualified daemon external: ${imported.path}`);
      }
    allInputs[output] = inputMetafile(result.metafile, output);
  }
  // Finite installed dependency closure, materialized without workspace symlinks.
  const copied = new Map();
  async function copyPackage(name, fromRequire) {
    let metadataPath;
    try {
      metadataPath = fromRequire.resolve(`${name}/package.json`);
    } catch {
      // Protocol deliberately exports only named entrypoints, never a root main.
      const entry = fromRequire.resolve(name === "@getpaseo/protocol" ? `${name}/messages` : name);
      let current = path.dirname(entry);
      for (;;) {
        try {
          const metadata = JSON.parse(await readFile(path.join(current, "package.json"), "utf8"));
          if (metadata.name === name) {
            metadataPath = path.join(current, "package.json");
            break;
          }
        } catch {
          /* Continue to the enclosing package boundary. */
        }
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
  await cp(path.join(packageRoot, "package.json"), path.join(outDir, "package.json"));
  const retainedBuiltins = await retainBuiltinPlugins(repositoryRoot, outDir);
  const compiledBuiltins = await precompileBuiltinPlugins(
    repositoryRoot,
    outDir,
    retainedBuiltins.sourceInputs,
    inputMetafile,
  );
  const finiteGit = await buildQualifiedGit(outDir);
  const sourceInputs = [
    ...retainedBuiltins.sourceInputs,
    ...compiledBuiltins.sourceInputs,
    ...finiteGit.sourceInputs,
  ];
  const inputNames = [
    ...new Set(Object.values(allInputs).flatMap((meta) => Object.keys(meta.inputs))),
  ].sort();
  for (const name of inputNames) {
    const raw = name.startsWith("qualified-disabled:")
      ? Buffer.from('throw new Error("Optional native accelerator disabled");')
      : await readFile(path.join(repositoryRoot, name));
    sourceInputs.push({ path: name, bytes: raw.length, sha256: digest(raw) });
  }
  await writeFile(
    path.join(outDir, "inputs.json"),
    JSON.stringify({
      schemaVersion: 2,
      distributionBuildId,
      builtinPlugins: retainedBuiltins.ids,
      builtinArtifacts: compiledBuiltins.artifacts,
      metafiles: allInputs,
      sourceInputs,
      builtinDependencies: [
        ...new Set(
          Object.values(allInputs).flatMap((meta) =>
            Object.values(meta.outputs).flatMap((row) =>
              row.imports.filter((item) => isBuiltin(item.path)).map((item) => item.path),
            ),
          ),
        ),
      ].sort(),
      packageLockSha256: digest(await readFile(path.join(repositoryRoot, "package-lock.json"))),
      finiteGit,
      toolchain: {
        node: process.version,
        versions: process.versions,
        esbuild: esbuildVersion,
        platform: process.platform,
        arch: process.arch,
      },
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
