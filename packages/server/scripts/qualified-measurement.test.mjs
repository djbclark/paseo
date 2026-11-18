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

test("finite Git C1 data preserves ordered includes and rejects extensions without granting execution", async () => {
  const { readBuiltinProfiles } =
    await import("../dist/server/server/execution/builtin-profile.js");
  const { readFiniteGitProfile } =
    await import("../dist/server/server/execution/finite-git-profile.js");
  const { canonicalBuiltinJson } =
    await import("../dist/server/server/execution/builtin-format.js");
  const { createHash } = await import("node:crypto");
  const recipe = {
    contract: "worktree-include-git-config-v1",
    distributionManifestSha256: "a".repeat(64),
    systemClosureSha256: "b".repeat(64),
    tools: { git: "runtime/git", observer: "runtime/git-observer", gate: "runtime/git-gate.so" },
    argv: {
      lsFiles: ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"],
      checkIgnore: ["check-ignore", "--stdin", "-z"],
    },
    repository: {
      cwd: "/protected/repository",
      gitDirectory: "/protected/repository/.git",
      layout: "direct-dotgit-v1",
    },
    environment: {
      HOME: "/home/account",
      GIT_CONFIG_SYSTEM: "/protected/config/system",
      GIT_CONFIG_GLOBAL: "/protected/config/global",
    },
    configRoots: {
      system: "/protected/config/system",
      global: "/protected/config/global",
      local: "/protected/repository/.git/config",
    },
    includes: [
      { from: "/protected/config/system", to: "/protected/config/include" },
      { from: "/protected/config/system", to: "/protected/config/include" },
    ],
    files: [
      "/protected/config/global",
      "/protected/config/include",
      "/protected/config/system",
      "/protected/repository/.git/config",
    ].map((file) => ({ path: file, mode: 292, size: 32, sha256: "c".repeat(64) })),
    protectedAbsent: [
      "/protected/repository/.git/commondir",
      "/protected/repository/.git/config.worktree",
    ],
  };
  const encoded = (value) => ({
    schemaVersion: 1,
    recipeSha256: createHash("sha256").update(canonicalBuiltinJson(value)).digest("hex"),
    recipe: value,
  });
  const finiteGit = encoded(recipe);
  const row = {
    id: "worktree-include",
    sourceSha256: "a".repeat(64),
    serverBundleSha256: "b".repeat(64),
    moduleTableSha256: "c".repeat(64),
    profileSha256: "d".repeat(64),
    activityContract: "builtin-in-process-v1",
    finiteGit,
  };
  assert.deepEqual(readBuiltinProfiles([row]), [row]);
  assert.equal(readFiniteGitProfile(finiteGit).recipe.includes.length, 2);
  for (const changed of [
    { ...recipe, permission: true },
    { ...recipe, tools: { ...recipe.tools, git: "candidate/git" } },
    { ...recipe, argv: { ...recipe.argv, checkIgnore: ["config", "--list"] } },
    { ...recipe, repository: { ...recipe.repository, gitDirectory: "/other/.git" } },
    { ...recipe, includes: [{ from: "/missing", to: "/protected/config/include" }] },
    { ...recipe, files: [...recipe.files, recipe.files[0]] },
    { ...recipe, protectedAbsent: [recipe.files[0].path] },
    { ...recipe, environment: { ...recipe.environment, GIT_CONFIG_GLOBAL: "/other" } },
  ])
    assert.equal(readFiniteGitProfile(encoded(changed)), null);
  assert.equal(readFiniteGitProfile({ ...finiteGit, recipeSha256: "0".repeat(64) }), null);
  const other = { ...row, id: "claude-usage-source" };
  delete other.finiteGit;
  assert.deepEqual(readBuiltinProfiles([other]), [other]);
  assert.equal(readBuiltinProfiles([{ ...other, finiteGit }]), null);
  const { assertQualifiedBuiltinInstance } =
    await import("../dist/server/server/execution/builtin-instance.js");
  assert.throws(() => assertQualifiedBuiltinInstance(row, { recipe: finiteGit }, row.id));
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
