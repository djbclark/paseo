import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const digest = (raw) => createHash("sha256").update(raw).digest("hex");
const sourceBase = "packages/server/src/server/agent/providers/opencode";
const builtBase = "packages/server/dist/server/server/agent/providers/opencode";
function sourceName(repository, workingDirectory, name) {
  const relative = path.relative(repository, path.resolve(repository, workingDirectory, name));
  if (path.isAbsolute(relative) || relative.split(path.sep).includes(".."))
    throw new Error("OpenCode bridge build input outside repository");
  return relative.split(path.sep).join("/");
}
function canonicalMetafile(repository, context, output, inputMetafile) {
  if (
    context.schemaVersion !== 1 ||
    typeof context.workingDirectory !== "string" ||
    path.isAbsolute(context.workingDirectory) ||
    context.workingDirectory.split(path.sep).includes("..")
  )
    throw new Error("OpenCode bridge build context unsupported");
  const name = (value) => sourceName(repository, context.workingDirectory, value);
  const inputs = Object.fromEntries(
    Object.entries(context.metafile.inputs).map(([key, row]) => [
      name(key),
      {
        ...row,
        imports: row.imports.map((item) => ({
          ...item,
          path: item.external ? item.path : name(item.path),
        })),
      },
    ]),
  );
  const emitted = Object.values(context.metafile.outputs);
  if (emitted.length !== 1) throw new Error("OpenCode bridge requires one original bundle output");
  for (const imported of emitted[0].imports)
    if (
      output !== "v2/bridge-plugin.bundle.mjs" ||
      imported.path !== "./state.mjs" ||
      imported.kind !== "dynamic-import" ||
      !imported.external
    )
      throw new Error("OpenCode bridge bundle must be closed except its explicit state asset");
  const outputs = {
    bundle: {
      ...emitted[0],
      entryPoint: name(emitted[0].entryPoint),
      inputs: Object.fromEntries(
        Object.entries(emitted[0].inputs).map(([key, row]) => [name(key), row]),
      ),
    },
  };
  return inputMetafile({ inputs, outputs }, output);
}
/** Copies the existing genuine workspace outputs. Never runs or recompiles the bridge. */
export async function retainQualifiedOpenCodeBridge(repository, root, inputMetafile) {
  const metafiles = {},
    outputs = [];
  await mkdir(path.join(root, "bridge-assets"), { recursive: true });
  for (const [version, directory] of [
    [1, ""],
    [2, "v2/"],
  ]) {
    const output = `${directory}bridge-plugin.bundle.mjs`;
    const builtPath = `${builtBase}/${output}`;
    const original = await readFile(path.join(repository, builtPath));
    const context = JSON.parse(
      await readFile(path.join(repository, `${builtPath}.meta.json`), "utf8"),
    );
    if (context.artifact.size !== original.length || context.artifact.sha256 !== digest(original))
      throw new Error("Original OpenCode bridge artifact differs from its build evidence");
    const meta = canonicalMetafile(repository, context, output, inputMetafile);
    const emitted = meta.outputs[output];
    if (
      emitted.entryPoint !== `${sourceBase}/${directory}bridge-plugin.mjs` ||
      emitted.bytes !== original.length
    )
      throw new Error("OpenCode bridge source/output mapping mismatch");
    await mkdir(path.dirname(path.join(root, output)), { recursive: true });
    await copyFile(path.join(repository, builtPath), path.join(root, output));
    const retained = await readFile(path.join(root, output));
    if (!retained.equals(original)) throw new Error("OpenCode bridge changed during retention");
    const metadataPath = `bridge-assets/v${version}.metafile.json`;
    const metadataRaw = JSON.stringify(meta);
    await writeFile(path.join(root, metadataPath), metadataRaw);
    metafiles[output] = meta;
    outputs.push({
      path: output,
      builtPath,
      size: retained.length,
      sha256: digest(retained),
      metadataPath,
      metadataSha256: digest(metadataRaw),
    });
  }
  const statePath = "v2/state.mjs";
  const state = await readFile(path.join(repository, builtBase, statePath));
  if (!state.equals(await readFile(path.join(repository, sourceBase, statePath))))
    throw new Error("OpenCode v2 state differs from original source");
  await copyFile(path.join(repository, builtBase, statePath), path.join(root, statePath));
  if (!state.equals(await readFile(path.join(root, statePath))))
    throw new Error("OpenCode v2 state changed during retention");
  outputs.push({
    path: statePath,
    builtPath: `${builtBase}/${statePath}`,
    size: state.length,
    sha256: digest(state),
  });
  const sourceInputs = [];
  for (const name of [
    `${sourceBase}/${statePath}`,
    "packages/server/scripts/build-opencode-bridge-plugin.mjs",
    "packages/server/scripts/retain-qualified-opencode-bridge.mjs",
  ]) {
    const raw = await readFile(path.join(repository, name));
    sourceInputs.push({ path: name, bytes: raw.length, sha256: digest(raw) });
  }
  await writeFile(
    path.join(root, "bridge-assets/identity.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "original-opencode-bridge-build",
      outputs,
      builder: sourceInputs.find((row) => row.path.endsWith("/build-opencode-bridge-plugin.mjs")),
    }),
  );
  return { metafiles, sourceInputs };
}

/** Cross-check against final byte identities; this record grants no permission. */
export async function assertRetainedOpenCodeBridge(root, inputs, files) {
  const record = JSON.parse(await readFile(path.join(root, "bridge-assets/identity.json"), "utf8"));
  const expected = ["bridge-plugin.bundle.mjs", "v2/bridge-plugin.bundle.mjs", "v2/state.mjs"];
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "original-opencode-bridge-build" ||
    JSON.stringify(record.outputs.map((row) => row.path)) !== JSON.stringify(expected)
  )
    throw new Error("OpenCode retained bridge inventory mismatch");
  const builder = inputs.sourceInputs.find(
    (row) => row.path === "packages/server/scripts/build-opencode-bridge-plugin.mjs",
  );
  if (!builder || JSON.stringify(record.builder) !== JSON.stringify(builder))
    throw new Error("OpenCode bridge builder provenance mismatch");
  for (const row of record.outputs) await assertBridgeOutput(root, inputs, files, row);
}
async function assertBridgeOutput(root, inputs, files, row) {
  const file = files.find((item) => item.path === row.path);
  if (
    !file ||
    file.mode !== 0o444 ||
    file.size !== row.size ||
    file.sha256 !== row.sha256 ||
    row.builtPath !== `${builtBase}/${row.path}`
  )
    throw new Error("OpenCode bridge original/retained byte identity mismatch");
  if (row.path === "v2/state.mjs") return;
  const expectedMetadata =
    row.path === "bridge-plugin.bundle.mjs"
      ? "bridge-assets/v1.metafile.json"
      : "bridge-assets/v2.metafile.json";
  if (row.metadataPath !== expectedMetadata)
    throw new Error("OpenCode bridge metadata path mismatch");
  const metadata = files.find((item) => item.path === row.metadataPath);
  if (
    !metadata ||
    metadata.sha256 !== row.metadataSha256 ||
    JSON.stringify(JSON.parse(await readFile(path.join(root, row.metadataPath), "utf8"))) !==
      JSON.stringify(inputs.metafiles[row.path])
  )
    throw new Error("OpenCode bridge module provenance mismatch");
}
