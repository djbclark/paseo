// Build-only fixed CI fixture. It retains the REAL producer/verifiers/SDK and
// separately inventories the fixture entry; no arbitrary entry/verifier option.
import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isBuiltin } from "node:module";
import {
  banner,
  externals,
  inputMetafile,
  qualifiedOptionalNativePlugin,
  phaseSingletonPlugin,
} from "./build-qualified-daemon.mjs";
const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const [stage, output] = process.argv.slice(2);
if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true" || !stage || !output)
  throw new Error("Fixed Linux CI owner fixture inputs required");
await mkdir(output);
await cp(stage, output, { recursive: true });
const inputs = JSON.parse(await readFile(path.join(output, "inputs.json"), "utf8"));
const result = await build({
  absWorkingDir: repository,
  entryPoints: ["packages/server/scripts/qualified-owner-composition-probe.ts"],
  outfile: path.join(output, "daemon.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  metafile: true,
  external: externals,
  banner: { js: banner },
  define: {
    __PASEO_QUALIFIED_PLUGIN_ENTRY__: "true",
    __QUALIFIED_DAEMON_ENTRY__: "true",
    __QUALIFIED_DISTRIBUTION_ID__: JSON.stringify(inputs.distributionBuildId),
  },
  plugins: [qualifiedOptionalNativePlugin, phaseSingletonPlugin],
  logLevel: "warning",
});
for (const emitted of Object.values(result.metafile.outputs))
  for (const imported of emitted.imports) {
    if (
      imported.external &&
      !isBuiltin(imported.path) &&
      imported.path !== "./startup-phase.mjs" &&
      !externals.some((name) => imported.path === name || imported.path.startsWith(`${name}/`))
    )
      throw new Error(`Unknown fixture external: ${imported.path}`);
  }
inputs.metafiles["daemon.mjs"] = inputMetafile(result.metafile, "daemon.mjs");
for (const name of Object.keys(inputs.metafiles["daemon.mjs"].inputs)) {
  if (inputs.sourceInputs.some((row) => row.path === name)) continue;
  const raw = name.startsWith("qualified-disabled:")
    ? Buffer.from('throw new Error("Optional native accelerator disabled");')
    : await readFile(path.join(repository, name));
  inputs.sourceInputs.push({
    path: name,
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
}
inputs.builtinDependencies = [
  ...new Set(
    Object.values(inputs.metafiles).flatMap((meta) =>
      Object.values(meta.outputs).flatMap((emitted) =>
        emitted.imports.filter((row) => isBuiltin(row.path)).map((row) => row.path),
      ),
    ),
  ),
].sort();
inputs.fixture = { version: 1, kind: "owner-sdk-composition-only", qualification: false };
await writeFile(path.join(output, "inputs.json"), JSON.stringify(inputs));
