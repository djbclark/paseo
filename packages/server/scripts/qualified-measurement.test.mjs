import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneBoundedObservation,
  parseQualifiedMeasurementRequest,
} from "../dist/server/server/execution/measurement-format.js";
test("fixed measurement request admits only type/version/bounded nonce", () => {
  const request = {
    type: "qualified.measurement.request",
    schemaVersion: 1,
    nonce: "valid-measurement-nonce",
  };
  assert.deepEqual(parseQualifiedMeasurementRequest(request), request);
  for (const added of [
    { command: "compile" },
    { path: "/candidate" },
    { ownerToken: "fake" },
    { operation: "replace" },
    { expectedIncarnation: "fake" },
  ])
    assert.equal(parseQualifiedMeasurementRequest({ ...request, ...added }), null);
  assert.equal(parseQualifiedMeasurementRequest({ ...request, nonce: "short" }), null);
  assert.equal(parseQualifiedMeasurementRequest({ ...request, nonce: "x".repeat(129) }), null);
});
test("pre-send bounded data retains Unicode and escaped byte content", () => {
  const observation = { nonce: "unicode", value: 'é雪😀\n"\\', rows: [null, true, 42] };
  assert.deepEqual(cloneBoundedObservation(observation), observation);
});
test("pre-send payload/count boundary refuses overflow and authority serialization", () => {
  for (const value of [
    { rows: Array(257).fill(null) },
    { value: "x".repeat(16777217) },
    { capability: { evidenceDigest: "fake" } },
    { ownerToken: "secret" },
    { scopeToken: "secret" },
    { call: () => {} },
    { value: 1n },
    { value: NaN },
  ])
    assert.throws(() => cloneBoundedObservation(value));
  let deep = null;
  for (let i = 0; i < 18; i++) deep = { nested: deep };
  assert.throws(() => cloneBoundedObservation(deep));
  assert.throws(() => cloneBoundedObservation({ value: "\0".repeat(3000000) }), /payload bound/);
});

// Canonical source/profile data is build/controller evidence, never a capability.
test("builtin canonical identity orders UTF-8 keys and rejects non-data or invalid Unicode", async () => {
  const { canonicalBuiltinJson } =
    await import("../dist/server/server/execution/builtin-format.js");
  assert.equal(
    canonicalBuiltinJson({ "😀": 2, "\ue000": 1, é: "雪" }),
    '{"é":"雪","\ue000":1,"😀":2}',
  );
  assert.equal(
    canonicalBuiltinJson({ b: [3, 2, 1], a: { z: false, n: null } }),
    '{"a":{"n":null,"z":false},"b":[3,2,1]}',
  );
  for (const value of [undefined, NaN, Infinity, () => {}, new Date(), "\ud800", { "\ud800": 1 }])
    assert.throws(() => canonicalBuiltinJson(value));
});
test("builtin profile rows require exact finite artifact identity without granting a brand", async () => {
  const { readBuiltinProfiles } =
    await import("../dist/server/server/execution/builtin-profile.js");
  const row = {
    id: "worktree-include",
    sourceSha256: "a".repeat(64),
    serverBundleSha256: "b".repeat(64),
    moduleTableSha256: "c".repeat(64),
    profileSha256: "d".repeat(64),
    activityContract: "builtin-in-process-v1",
  };
  assert.deepEqual(readBuiltinProfiles([row]), [row]);
  for (const value of [
    undefined,
    {},
    [row, row],
    [{ ...row, id: "candidate" }],
    [{ ...row, profileSha256: "D".repeat(64) }],
    [{ ...row, permission: true }],
    [{ ...row, activityContract: "plugin-child" }],
  ])
    assert.equal(readBuiltinProfiles(value), null);
});

test("descriptive builtin data and wrong role cannot mint an original instance", async () => {
  const producer = await import("../dist/server/server/execution/builtin-instance.js");
  const fakeOwner = {
    root: "/retained",
    binding: { expectedIncarnation: "fake" },
    assertFresh() {},
    refresh: async () => {},
  };
  assert.throws(() => producer.assertQualifiedBuiltinInstance({}, fakeOwner, "worktree-include"));
  await assert.rejects(() =>
    producer.createQualifiedBuiltinInstance(fakeOwner, "worktree-include"),
  );
});

test("measurement explicitly requests V2 without adding selectors or coercing V1", () => {
  assert.deepEqual(
    parseQualifiedMeasurementRequest({
      type: "qualified.measurement.request",
      schemaVersion: 2,
      nonce: "abcdefghijklmnop",
    }),
    { type: "qualified.measurement.request", schemaVersion: 2, nonce: "abcdefghijklmnop" },
  );
  assert.equal(
    parseQualifiedMeasurementRequest({
      type: "qualified.measurement.request",
      schemaVersion: 3,
      nonce: "abcdefghijklmnop",
    }),
    null,
  );
});

test("finite ELF/cache parser derives actual Linux runtime inputs and rejects malformed metadata", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux ELF profile only");
  const { readFile } = await import("node:fs/promises");
  const { describeElf, describeLoaderCache } =
    await import("../dist/server/server/execution/elf-format.js");
  const bytes = await readFile(process.execPath);
  const elf = describeElf(bytes);
  assert.equal(elf.machine, process.arch === "x64" ? 62 : 183);
  assert.ok(elf.interpreter?.startsWith("/"));
  assert.ok(elf.needed.length > 0);
  for (const malformed of [Buffer.alloc(0), bytes.subarray(0, 60), Buffer.from(bytes)]) {
    if (malformed.length === bytes.length) malformed[5] = 2;
    assert.throws(() => describeElf(malformed));
  }
  const changed = Buffer.from(bytes);
  const ph = Number(changed.readBigUInt64LE(32));
  for (let i = 0; i < changed.readUInt16LE(56); i++) {
    const row = ph + i * changed.readUInt16LE(54);
    if (changed.readUInt32LE(row) === 2) {
      changed.writeBigInt64LE(0x6ffffefcn, Number(changed.readBigUInt64LE(row + 8)));
      break;
    }
  }
  assert.throws(() => describeElf(changed));
  const cache = await readFile("/etc/ld.so.cache");
  const entries = describeLoaderCache(cache, elf.machine);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((row) => row.path.startsWith("/")));
  assert.throws(() => describeLoaderCache(cache.subarray(0, 48), elf.machine));
});

test("retained system metadata refuses old missing-payload manifests and unknown loader fields", async () => {
  const { SystemClosureSchema, assertSystemClosureMetadata } =
    await import("../dist/server/server/execution/system-closure.js");
  assert.equal(SystemClosureSchema.safeParse(undefined).success, false);
  assert.throws(() => assertSystemClosureMetadata({ files: [], externalLibraries: [] }));
  assert.equal(
    SystemClosureSchema.safeParse({
      schemaVersion: 1,
      profile: "linux-retained-system-closure-v1",
      mountCommand: "override",
    }).success,
    false,
  );
});
