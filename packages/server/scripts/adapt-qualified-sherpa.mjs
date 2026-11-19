// Exact copied-member build recipe. No installed package or live host mutation.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, mkdir, writeFile, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { auditSherpaElf, assertSherpaAdaptationSemantics } from "./sherpa-elf-audit.mjs";
import { describeElf } from "../dist/server/server/execution/elf-format.js";
import { canonicalBuiltinJson } from "../dist/server/server/execution/builtin-format.js";

const run = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sherpaAddonMember = "node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node";
const originalSha = "c139574c7a2323710bdd647c5ee27c200669fa4f65f205d8b04eda12a63fece2";
const originalRunpath = "$ORIGIN:/home/runner/work/sherpa-onnx/sherpa-onnx/build/install/lib:";
const revision = "86d3d00e28c22c102fb7d01c7b62fdc4e7a69f1b";
const dependencies = [
  [
    "libsherpa-onnx-c-api.so",
    5558624,
    "a1675fd6d4cb726db0bbed629325c1f871387ddcdba668529601ea1af02e300e",
  ],
  [
    "libsherpa-onnx-cxx-api.so",
    224984,
    "ce4dd50ab292b2d33c258af894ee5bb39b3ca7000977d2420716864a3fcaaf4f",
  ],
  [
    "libonnxruntime.so",
    23665137,
    "7a6019216c8b6194101291ab8cd1ad9803f087306b10f6f0ef384c52fe879138",
  ],
];
const stamp = (s) =>
  [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
async function bytes(file, limit, trustedTool = false) {
  const descriptor = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await descriptor.stat({ bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n && before.size <= BigInt(limit));
    if (trustedTool) assert.ok(before.uid === 0n && !(before.mode & 0o022n));
    const data = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    for (;;) {
      const result = await descriptor.read(data, used, data.length - used, null);
      if (!result.bytesRead) break;
      used += result.bytesRead;
      assert.ok(used <= Number(before.size));
    }
    assert.equal(stamp(before), stamp(await descriptor.stat({ bigint: true })));
    assert.equal(stamp(before), stamp(await lstat(file, { bigint: true })));
    assert.equal(used, Number(before.size));
    return data.subarray(0, used);
  } finally {
    await descriptor.close();
  }
}
export function assertExactSherpaInput(data) {
  assert.equal(data.length, 840296);
  assert.equal(sha(data), originalSha);
  const metadata = auditSherpaElf(data);
  assert.deepEqual(
    metadata.dynamicTags.filter((p) => p.tag === 29),
    [{ tag: 29, value: originalRunpath }],
  );
  assert.deepEqual(
    metadata.dynamicTags.filter((p) => p.tag === 15),
    [],
  );
  assert.deepEqual(
    metadata.dynamicTags.filter((p) => p.tag === 14),
    [{ tag: 14, value: "sherpa-onnx.node" }],
  );
  assert.deepEqual(
    metadata.dynamicTags.filter((p) => p.tag === 1).map((p) => p.value),
    ["libsherpa-onnx-c-api.so", "libstdc++.so.6", "libgcc_s.so.1", "libc.so.6"],
  );
  return metadata;
}
async function retain(root, name, data) {
  const relative = `native-provenance/${name}`;
  await writeFile(path.join(root, relative), data, { mode: 0o444, flag: "wx" });
  return { path: relative, mode: 0o444, size: data.length, sha256: sha(data) };
}
async function source(root, name, url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 1024 * 1024);
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  return { url, sha256: sha(data), retained: await retain(root, name, data) };
}
export async function adaptQualifiedSherpa(root) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const member = path.join(root, sherpaAddonMember);
  const original = await bytes(member, 840296);
  const before = assertExactSherpaInput(original);
  const siblingRows = [];
  for (const [name, size, expected] of dependencies) {
    const data = await bytes(path.join(path.dirname(member), name), size);
    assert.equal(data.length, size);
    assert.equal(sha(data), expected);
    siblingRows.push({
      path: `node_modules/sherpa-onnx-linux-x64/${name}`,
      sha256: expected,
      size,
      metadata: describeElf(data),
    });
  }
  // This existing build tool is measured, never installed or selected from PATH.
  const tool = await realpath("/usr/bin/patchelf");
  let parent = path.dirname(tool);
  for (;;) {
    const info = await lstat(parent, { bigint: true });
    assert.ok(info.isDirectory() && info.uid === 0n && !(info.mode & 0o022n));
    if (parent === "/") break;
    parent = path.dirname(parent);
  }
  const toolBytes = await bytes(tool, 16 * 1024 * 1024, true);
  const toolVersion = (
    await run(tool, ["--version"], { timeout: 10000, maxBuffer: 4096 })
  ).stdout.trim();
  await mkdir(path.join(root, "native-provenance"), { recursive: true });
  const originalProvenance = await retain(root, "sherpa-addon-original.gz", gzipSync(original));
  const toolProvenance = await retain(root, "patchelf-build-tool.gz", gzipSync(toolBytes));
  const sources = [];
  for (const [name, file] of [
    ["sherpa-cmake.txt", "scripts/node-addon-api/CMakeLists.txt"],
    ["sherpa-publish.txt", ".github/scripts/node-addon/run.sh"],
    ["sherpa-cpu-session.txt", "sherpa-onnx/csrc/session.cc"],
    ["sherpa-ort-recipe.txt", "cmake/onnxruntime-linux-x86_64.cmake"],
  ])
    sources.push(
      await source(
        root,
        name,
        `https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/${revision}/${file}`,
      ),
    );
  const ortRevision = "a83fc4d58cb48eb68890dd689f94f28288cf2278";
  for (const [name, file] of [
    ["ort-provider-bridge.txt", "onnxruntime/core/session/provider_bridge_ort.cc"],
    ["ort-posix-loader.txt", "onnxruntime/core/platform/posix/env.cc"],
    ["ort-custom-ops.txt", "onnxruntime/core/session/abi_session_options.cc"],
  ])
    sources.push(
      await source(
        root,
        name,
        `https://raw.githubusercontent.com/csukuangfj/onnxruntime/${ortRevision}/${file}`,
      ),
    );
  const argv = ["--set-rpath", "$ORIGIN", sherpaAddonMember];
  assert.equal(sha(await bytes(member, 840296)), originalSha);
  await run(tool, argv, { cwd: root, timeout: 15000, maxBuffer: 65536 });
  assert.equal(sha(await bytes(tool, 16 * 1024 * 1024, true)), sha(toolBytes));
  const adapted = await bytes(member, 2 * 1024 * 1024);
  const after = auditSherpaElf(adapted);
  assertSherpaAdaptationSemantics(before, after);
  const strict = describeElf(adapted);
  assert.deepEqual(strict.runpath, ["$ORIGIN"]);
  const recipe = {
    package: {
      name: "sherpa-onnx-linux-x64",
      version: "1.12.28",
      integrity:
        "sha512-+7ZwpAqQYz5fjNQ13F9+sR11zKo6+HhOa1OvT+F4g4PjmoCS1o3YYQqT4JZuLeNRWAY6kKn4IXGWLx93K+OV7A==",
      sourceRevision: revision,
    },
    member: sherpaAddonMember,
    original: {
      sha256: originalSha,
      size: original.length,
      provenance: originalProvenance,
      metadata: before,
    },
    transformation: {
      tool: "patchelf",
      argv,
      toolSha256: sha(toolBytes),
      toolSize: toolBytes.length,
      toolVersion,
      toolProvenance,
    },
    sources,
    dependencies: siblingRows,
  };
  const record = {
    schemaVersion: 1,
    recipeId: "sherpa-onnx-linux-x64-1.12.28-origin-v1",
    recipeSha256: sha(canonicalBuiltinJson(recipe)),
    recipe,
    output: { sha256: sha(adapted), size: adapted.length, metadata: after },
  };
  const recordBytes = Buffer.from(canonicalBuiltinJson(record));
  assert.ok(recordBytes.length <= 4 * 1024 * 1024);
  const recordFile = await retain(root, "sherpa-addon-adaptation.json", recordBytes);
  return { record: recordFile, recipeSha256: record.recipeSha256, qualification: false };
}
