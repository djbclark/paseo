import { constants } from "node:fs";
import { open, lstat, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageSource = "packages/cli/package.json";
const versionSource = "packages/cli/src/version.ts";
const helperSource = "packages/server/scripts/retain-qualified-cli-metadata.mjs";
const metadataPath = "cli-package.json";
const recordPath = "cli-assets/metadata.json";
const relocatedPath = "cli-assets/version.ts";
const originalLookup = 'require("../package.json")';
const retainedLookup = 'require("./cli-package.json")';
const modules = ["cli-code.mjs", "client-code.mjs"];
const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularBytes(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let result;
  let failure;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 1048576n)
      throw new Error("Invalid CLI metadata source leaf");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const block = await handle.read(buffer, offset, buffer.length - offset);
      if (!block.bytesRead) break;
      offset += block.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    for (const key of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"])
      if (before[key] !== after[key] || before[key] !== current[key])
        throw new Error("CLI metadata source changed");
    if (BigInt(offset) !== before.size) throw new Error("CLI metadata source length changed");
    result = { raw: buffer.subarray(0, offset), mode: Number(before.mode & 0o777n) };
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "CLI source read and close failed")
      : error;
  }
  if (failure) throw failure;
  return result;
}

function sourceIdentity(name, raw) {
  return { path: name, bytes: raw.length, sha256: digest(raw) };
}
function relocateVersion(raw) {
  const source = raw.toString("utf8");
  if (!Buffer.from(source).equals(raw) || source.split(originalLookup).length !== 2)
    throw new Error("Unknown original CLI metadata lookup");
  return Buffer.from(source.replace(originalLookup, retainedLookup));
}
async function describe(repo) {
  const packageBytes = (await regularBytes(path.join(repo, packageSource))).raw;
  const parsed = JSON.parse(packageBytes.toString("utf8"));
  if (
    parsed.name !== "@getpaseo/cli" ||
    typeof parsed.version !== "string" ||
    !parsed.version.trim()
  )
    throw new Error("Original CLI package metadata unavailable");
  const versionBytes = (await regularBytes(path.join(repo, versionSource))).raw;
  const adapted = relocateVersion(versionBytes);
  const helperBytes = (await regularBytes(path.join(repo, helperSource))).raw;
  const record = {
    schemaVersion: 1,
    kind: "retained-original-cli-metadata",
    qualification: false,
    package: sourceIdentity(packageSource, packageBytes),
    metadata: {
      path: metadataPath,
      mode: 0o444,
      size: packageBytes.length,
      sha256: digest(packageBytes),
    },
    versionSource: sourceIdentity(versionSource, versionBytes),
    relocatedSource: {
      path: relocatedPath,
      mode: 0o444,
      size: adapted.length,
      sha256: digest(adapted),
    },
    relocation: { from: originalLookup, to: retainedLookup, replacements: 1 },
    modules,
    builder: sourceIdentity(helperSource, helperBytes),
  };
  return { record, packageBytes, adapted };
}

/** Fixed build-only path relocation. Original source and package bytes stay recorded. */
export async function retainQualifiedCliMetadata(repo, root) {
  const prepared = await describe(repo);
  await mkdir(path.join(root, "cli-assets"), { recursive: true });
  await writeFile(path.join(root, metadataPath), prepared.packageBytes, {
    mode: 0o444,
    flag: "wx",
  });
  await writeFile(path.join(root, relocatedPath), prepared.adapted, { mode: 0o444, flag: "wx" });
  await writeFile(path.join(root, recordPath), JSON.stringify(prepared.record), {
    mode: 0o444,
    flag: "wx",
  });
  const exactSource = path.join(repo, versionSource);
  return {
    sourceInputs: [prepared.record.package, prepared.record.builder],
    plugin: {
      name: "retained-original-cli-metadata",
      setup(builder) {
        builder.onLoad({ filter: /[/]packages[/]cli[/]src[/]version\.ts$/ }, (args) => {
          if (args.path !== exactSource) throw new Error("Unexpected CLI version source");
          return {
            contents: prepared.adapted.toString("utf8"),
            loader: "ts",
            resolveDir: path.dirname(exactSource),
          };
        });
      },
    },
  };
}

/** Build DATA cross-check only; the real runtime still verifies the full closure. */
export async function assertRetainedCliMetadata(root, inputs, files) {
  const expected = await describe(repository);
  const recordBytes = (await regularBytes(path.join(root, recordPath))).raw;
  if (JSON.stringify(JSON.parse(recordBytes.toString("utf8"))) !== JSON.stringify(expected.record))
    throw new Error("Retained CLI metadata provenance mismatch");
  const actualModules = Object.entries(inputs.metafiles)
    .filter(([, meta]) => Object.hasOwn(meta.inputs, versionSource))
    .map(([name]) => name)
    .sort();
  if (JSON.stringify(actualModules) !== JSON.stringify(modules))
    throw new Error("Retained CLI module provenance mismatch");
  for (const name of modules)
    if (inputs.metafiles[name].inputs[versionSource].bytes !== expected.record.relocatedSource.size)
      throw new Error("Retained CLI loaded source identity mismatch");
  for (const source of [
    expected.record.package,
    expected.record.versionSource,
    expected.record.builder,
  ]) {
    const matching = inputs.sourceInputs.filter((row) => row.path === source.path);
    if (matching.length !== 1 || JSON.stringify(matching[0]) !== JSON.stringify(source))
      throw new Error("Retained CLI source provenance mismatch");
  }
  for (const name of [metadataPath, recordPath, relocatedPath]) {
    const actual = await regularBytes(path.join(root, name));
    const identity = {
      path: name,
      mode: actual.mode,
      size: actual.raw.length,
      sha256: digest(actual.raw),
    };
    if (JSON.stringify(files.find((row) => row.path === name)) !== JSON.stringify(identity))
      throw new Error("Retained CLI bytes differ from final manifest");
    if (name === relocatedPath && !actual.raw.equals(expected.adapted))
      throw new Error("Retained CLI loaded source differs from recorded relocation");
    if (name === metadataPath && !actual.raw.equals(expected.packageBytes))
      throw new Error("Retained CLI package bytes differ from original");
  }
}
