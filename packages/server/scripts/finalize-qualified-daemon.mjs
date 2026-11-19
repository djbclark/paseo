import { daemonHelperInventory } from "../dist/server/server/execution/daemon-helper-inventory.js";
import { createHash } from "node:crypto";
import { assertSystemClosureMetadata } from "../dist/server/server/execution/system-closure.js";
import { canonicalBuiltinJson } from "../dist/server/server/execution/builtin-format.js";
import {
  chmod,
  cp,
  mkdir,
  readdir,
  lstat,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { retainSystemClosure } from "./retain-system-closure.mjs";
import { assertRetainedOpenCodeBridge } from "./retain-qualified-opencode-bridge.mjs";
import { assertRetainedCliMetadata } from "./retain-qualified-cli-metadata.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import builtinBindingsRecipe from "../src/server/execution/builtin-bindings-recipe.json" with { type: "json" };
import builtinPlugins from "../src/server/execution/builtin-inventory.json" with { type: "json" };
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function identity(file, name = file) {
  const stat = await lstat(file);
  if (!stat.isFile()) throw new Error("Nonregular daemon closure member");
  return {
    path: name,
    mode: stat.mode & 0o777,
    size: stat.size,
    sha256: digest(await readFile(file)),
  };
}
export async function finalizeQualifiedDaemon(root, runtime, qualificationSha256) {
  if (
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch) ||
    !/^[a-f0-9]{64}$/.test(qualificationSha256)
  )
    throw new Error("Linux qualification recipe digest required");
  root = await realpath(root);
  const inputs = JSON.parse(await readFile(path.join(root, "inputs.json"), "utf8"));
  if (JSON.stringify(inputs.builtinPlugins) !== JSON.stringify(builtinPlugins))
    throw new Error("Finite builtin inventory mismatch");
  await mkdir(path.join(root, "runtime"), { recursive: true });
  const esbuild = path.join(root, "node_modules", `@esbuild/linux-${process.arch}/bin/esbuild`);
  for (const [source, target] of [
    [runtime, "node"],
    [esbuild, "esbuild"],
  ]) {
    const destination = path.join(root, "runtime", target);
    await rm(destination, { force: true });
    await cp(source, destination);
    await chmod(destination, 0o555);
  }
  const { externalLibraries, systemClosure } = await retainSystemClosure(root);
  const systemClosureSha256 = digest(canonicalBuiltinJson(systemClosure));
  const files = [];
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) {
        await visit(file);
        await chmod(file, 0o555);
      } else {
        if (!stat.isFile()) throw new Error("Symlink/special daemon closure member");
        await chmod(file, stat.mode & 0o111 ? 0o555 : 0o444);
        files.push(await identity(file, path.relative(root, file)));
      }
    }
  }
  await visit(root);
  await chmod(root, 0o555);
  files.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  await assertRetainedOpenCodeBridge(root, inputs, files);
  await assertRetainedCliMetadata(root, inputs, files);
  const helperInventory = daemonHelperInventory({ files, externalLibraries });
  const adaptation = files.find(
    (file) => file.path === "native-provenance/sherpa-addon-adaptation.json",
  );
  if (!adaptation || adaptation.sha256 !== inputs.copiedSherpa?.record.sha256)
    throw new Error("Copied Sherpa provenance identity mismatch");
  const builtinModuleTable = {
    schemaVersion: 1,
    recipe: {
      ...builtinBindingsRecipe,
      copiedSherpaAddonRecipeSha256: inputs.copiedSherpa.record.sha256,
    },
    runtimeSha256: files.find((file) => file.path === "runtime/node").sha256,
    daemonSha256: files.find((file) => file.path === "daemon.mjs").sha256,
    externalLibraries,
    systemClosureSha256,
  };
  const moduleTableSha256 = digest(canonicalBuiltinJson(builtinModuleTable));
  const manifest = {
    schemaVersion: 2,
    profile: "enclosing-daemon-v2",
    systemClosure,
    systemClosureSha256,
    builtinPlugins,
    builtinModuleTable,
    moduleTableSha256,
    builtinArtifacts: inputs.builtinArtifacts.map((row) => ({ ...row, moduleTableSha256 })),
    distributionBuildId: inputs.distributionBuildId,
    files,
    runtime: files.find((file) => file.path === "runtime/node"),
    esbuild: files.find((file) => file.path === "runtime/esbuild"),
    externalLibraries,
    helperInventory,
    helperClosureSha256: digest(JSON.stringify(helperInventory)),
    entries: {
      daemon: "daemon.mjs",
      pluginChild: "plugin-child-entry.mjs",
      compiler: "compiler-entry.mjs",
      terminal: "terminal-entry.mjs",
    },
    bindingKeys: [
      "@getpaseo/plugin/internal/activity",
      "@getpaseo/plugin/internal/builtin-helper",
      "@getpaseo/plugin",
      "@getpaseo/plugin/server",
      "@getpaseo/plugin/server/provider",
      "@getpaseo/plugin/server/acp",
      "@getpaseo/plugin/server/usage",
      "@getpaseo/client",
      "@getpaseo/client/internal/daemon-client",
      "@getpaseo/protocol/binary-frames/index",
      "zod",
    ].sort(),
  };
  assertSystemClosureMetadata(manifest);
  const raw = JSON.stringify(manifest);
  await writeFile(`${root}.manifest.json`, raw);
  return {
    immutabilityAdapter: "linux-root-owned-retained-v1",
    immutableRoot: root,
    distributionBuildId: inputs.distributionBuildId,
    manifestSha256: digest(raw),
    qualificationSha256,
  };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [root, runtime, qualification] = process.argv.slice(2);
  process.stdout.write(
    JSON.stringify(await finalizeQualifiedDaemon(root, runtime, qualification)) + "\n",
  );
}
