import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export async function buildQualifiedHost({ outDir, distributionBuildId, roleBuildId }) {
  if (!distributionBuildId || !roleBuildId) throw new Error("CI build identities required");
  await mkdir(outDir, { recursive: true });
  const common = {
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    metafile: true,
    define: {
      __PASEO_QUALIFIED_PLUGIN_ENTRY__: "true",
      __QUALIFIED_DISTRIBUTION_ID__: JSON.stringify(distributionBuildId),
      __QUALIFIED_ROLE_ID__: JSON.stringify(roleBuildId),
    },
    logLevel: "warning",
  };
  const host = await build({
    ...common,
    entryPoints: [path.join(packageRoot, "src/server/execution/qualified-host.ts")],
    outfile: path.join(outDir, "host.cjs"),
    plugins: [
      {
        name: "explicit-optional-native-addons-disabled",
        setup(builder) {
          builder.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (args) => ({
            path: args.path,
            namespace: "qualified-disabled",
          }));
          builder.onLoad({ filter: /.*/, namespace: "qualified-disabled" }, () => ({
            contents: 'throw new Error("Optional native addon disabled in qualified host");',
            loader: "js",
          }));
        },
      },
    ],
  });
  for (const output of Object.values(host.metafile.outputs))
    for (const imported of output.imports) {
      if (imported.external && !isBuiltin(imported.path))
        throw new Error(`Unqualified host external: ${imported.path}`);
    }
  await build({
    ...common,
    entryPoints: [path.join(packageRoot, "src/server/execution/role-bootstrap.ts")],
    outfile: path.join(outDir, "role.cjs"),
  });
  await build({
    ...common,
    entryPoints: [path.join(packageRoot, "src/server/execution/qualified-launcher.ts")],
    outfile: path.join(outDir, "launcher.cjs"),
  });
  await writeFile(
    path.join(outDir, "inputs.json"),
    JSON.stringify({ schemaVersion: 1, distributionBuildId, roleBuildId, metafile: host.metafile }),
  );
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [outDir, distributionBuildId, roleBuildId] = process.argv.slice(2);
  if (!outDir) throw new Error("output directory required");
  await buildQualifiedHost({ outDir: path.resolve(outDir), distributionBuildId, roleBuildId });
}
