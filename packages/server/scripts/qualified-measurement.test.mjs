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
  const runtime = await import("../dist/server/server/execution/finite-git-runtime.js");
  assert.throws(() => runtime.assertPreparedQualifiedBuiltinGit({}, fakeOwner));
  assert.equal(runtime.qualifiedBuiltinGitPermit({}, fakeOwner, {}), null);
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

// These are data-only ELF validation checks. No native addon is imported/executed.
test("exact copied Sherpa recipe preserves code/relocation/init semantics and rejects changed input", async () => {
  const { createRequire } = await import("node:module");
  const { readFile } = await import("node:fs/promises");
  const require = createRequire(import.meta.url);
  const { assertExactSherpaInput } = await import("./adapt-qualified-sherpa.mjs");
  const { auditSherpaElf, assertSherpaAdaptationSemantics } =
    await import("./sherpa-elf-audit.mjs");
  const original = await readFile(require.resolve("sherpa-onnx-linux-x64/sherpa-onnx.node"));
  const before = assertExactSherpaInput(original);
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => assertExactSherpaInput(changed));
  const old = "$ORIGIN:/home/runner/work/sherpa-onnx/sherpa-onnx/build/install/lib:";
  const strings = before.sections.find((row) => row.name === ".dynstr");
  assert.ok(strings);
  const offset = original.indexOf(Buffer.from(old), strings.offset);
  assert.ok(offset >= strings.offset && offset + old.length < strings.offset + strings.size);
  const rewritten = Buffer.from(original);
  rewritten.fill(0, offset, offset + old.length);
  rewritten.write("$ORIGIN", offset);
  const after = auditSherpaElf(rewritten);
  assertSherpaAdaptationSemantics(before, after);
  const text = after.sections.find((row) => row.name === ".text");
  assert.ok(text?.size);
  const corruptCode = Buffer.from(rewritten);
  corruptCode[text.offset] ^= 1;
  assert.throws(() => assertSherpaAdaptationSemantics(before, auditSherpaElf(corruptCode)));
  const reloc = after.sections.find((row) => row.name === ".rela.dyn");
  assert.ok(reloc?.size);
  const corruptReloc = Buffer.from(rewritten);
  corruptReloc[reloc.offset] ^= 1;
  assert.throws(() => assertSherpaAdaptationSemantics(before, auditSherpaElf(corruptReloc)));
  assert.throws(() => assertSherpaAdaptationSemantics(after, before));
});

test("finite Git startup projects only the declared original closed environment", async () => {
  const { declaredFiniteGitEnvironment } =
    await import("../dist/server/server/execution/finite-git-environment.js");
  const { userInfo } = await import("node:os");
  const base = {
    PATH: "/usr/bin:/bin",
    HOME: userInfo().homedir,
    PASEO_MANAGED_PLUGIN_POLICY: "/protected/native-policy.json",
  };
  const home = "/protected/paseo-home";
  const declared = {
    ...base,
    PASEO_HOME: home,
    GIT_CONFIG_SYSTEM: "/protected/system",
    GIT_CONFIG_GLOBAL: "/protected/global",
    LC_ALL: "C",
  };
  const profile = {
    recipe: {
      environment: declared,
      configRoots: { system: declared.GIT_CONFIG_SYSTEM, global: declared.GIT_CONFIG_GLOBAL },
    },
  };
  assert.deepEqual(declaredFiniteGitEnvironment(profile, base, home), declared);
  for (const changed of [
    { ...declared, EXTRA: "ambient" },
    { ...declared, GIT_CONFIG_SYSTEM: "/ambient/system" },
    { ...declared, HOME: "/ambient/home" },
    { ...declared, PASEO_HOME: "/other" },
    { ...declared, LC_ALL: "unreviewed" },
  ])
    assert.throws(() =>
      declaredFiniteGitEnvironment(
        { recipe: { ...profile.recipe, environment: changed } },
        base,
        home,
      ),
    );
});
test("counterfeit continuation data and SDK roots never mint an owner continuation", async () => {
  const {
    captureQualifiedBuiltinContinuation,
    activateQualifiedBuiltinContinuation,
    assertQualifiedBuiltinContinuationIdentity,
    readQualifiedBuiltinContinuation,
    finishQualifiedBuiltinContinuation,
    isQualifiedDaemonOwner,
  } = await import("../dist/server/server/execution/daemon-owner.js");
  const token = { settled: Promise.resolve() };
  await assert.rejects(() => activateQualifiedBuiltinContinuation(token));
  assert.throws(() => assertQualifiedBuiltinContinuationIdentity(token));
  assert.throws(() => readQualifiedBuiltinContinuation(token));
  await assert.rejects(() => finishQualifiedBuiltinContinuation(token));
  assert.throws(() =>
    captureQualifiedBuiltinContinuation({}, {}, { root: {}, activityOwner: {}, operation: {} }),
  );
  assert.equal(isQualifiedDaemonOwner(token), false);
});

test(
  "retained search selection requires measured ELF and stable actual bytes",
  {
    skip: process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true",
  },
  async () => {
    const { assertRetainedSearchElf } =
      await import("../dist/server/server/execution/system-closure.js");
    const { describeElf } = await import("../dist/server/server/execution/elf-format.js");
    const { spawnSync } = await import("node:child_process");
    const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { createHash, randomUUID } = await import("node:crypto");
    function admin(args) {
      const result = spawnSync("sudo", ["-k", "-n", ...args], { encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
    }
    const temporary = await mkdtemp(path.join(tmpdir(), "retained-elf-input-"));
    const root = `/paseo-retained-elf-source-${randomUUID()}`;
    const member = "libfixture.so",
      target = path.join(root, member);
    const original = await readFile("/usr/bin/true");
    const measured = { member, ...describeElf(original) };
    const identity = (bytes) => ({
      path: member,
      mode: 292,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const manifest = (bytes, elf = [measured]) => ({
      files: [identity(bytes)],
      externalLibraries: [],
      systemClosure: { loaderResolution: { elf } },
    });
    async function install(bytes) {
      const source = path.join(temporary, "member");
      await writeFile(source, bytes);
      admin(["install", "-o", "root", "-g", "root", "-m", "0444", source, target]);
    }
    async function baseline() {
      await install(original);
      await assertRetainedSearchElf(root, manifest(original), target);
    }
    try {
      admin(["install", "-d", "-o", "root", "-g", "root", "-m", "0555", root]);
      await baseline();
      await assert.rejects(
        () => assertRetainedSearchElf(root, manifest(original, []), target),
        "files membership alone must refuse",
      );
      await baseline();
      const nonElf = Buffer.alloc(original.length, 0x61);
      await install(nonElf);
      await assert.rejects(
        () => assertRetainedSearchElf(root, manifest(nonElf), target),
        "matching file hash with false ELF metadata must refuse",
      );
      await baseline();
      const changed = Buffer.from(original);
      changed[changed.length - 1] ^= 1;
      await install(changed);
      await assert.rejects(
        () => assertRetainedSearchElf(root, manifest(original), target),
        "changed actual ELF bytes must refuse",
      );
      await baseline();
      const changedMetadata = {
        ...measured,
        needed: [...measured.needed, "undeclared-library.so"],
      };
      await assert.rejects(
        () => assertRetainedSearchElf(root, manifest(original, [changedMetadata]), target),
        "actual ELF metadata must equal its measured row",
      );
      await baseline();
      await assert.rejects(
        () => assertRetainedSearchElf(root, manifest(original), "/usr/bin/true"),
        "outside-root measured names cannot authorize host files",
      );
    } finally {
      admin(["rm", "-rf", root]);
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

// Artifact metadata is build acceptance DATA, never an execution capability.
test("build TAR and actual uploaded ZIP budgets preserve exact identity and limits", async () => {
  const { assertQualifiedTarBudget, assertQualifiedBuildArtifact, BUILD_ARCHIVE_LIMITS } =
    await import("./qualified-build-budget.mjs");
  assert.deepEqual(assertQualifiedTarBudget(BUILD_ARCHIVE_LIMITS.tarBytes, "root/\n"), {
    bytes: BUILD_ARCHIVE_LIMITS.tarBytes,
    members: 1,
  });
  assert.equal(
    assertQualifiedTarBudget(1024, "member\n".repeat(BUILD_ARCHIVE_LIMITS.members)).members,
    BUILD_ARCHIVE_LIMITS.members,
  );
  for (const bytes of [0, -1, NaN, Infinity, 1.5, BUILD_ARCHIVE_LIMITS.tarBytes + 1])
    assert.throws(() => assertQualifiedTarBudget(bytes, "root/\n"));
  for (const listing of ["", "missing-newline", "\n", "root/\n\n", "m\n".repeat(10001)])
    assert.throws(() => assertQualifiedTarBudget(1024, listing));
  const expected = { artifactId: "10", runId: "20", attempt: "1", head: "a".repeat(40) };
  const baseline = {
    id: 10,
    name: `qualified-daemon-build-${expected.head}-20-1`,
    expired: false,
    size_in_bytes: BUILD_ARCHIVE_LIMITS.zipBytes,
    workflow_run: {
      id: 20,
      head_sha: expected.head,
      repository_id: 1432178170,
      head_repository_id: 1432178170,
    },
  };
  const positive = () =>
    assert.deepEqual(assertQualifiedBuildArtifact(baseline, expected), {
      artifactId: "10",
      zipBytes: BUILD_ARCHIVE_LIMITS.zipBytes,
      qualification: false,
    });
  positive();
  for (const mutation of [
    { id: 11 },
    { name: baseline.name.replace("-20-1", "-20-2") },
    { expired: true },
    { size_in_bytes: BUILD_ARCHIVE_LIMITS.zipBytes + 1 },
    { size_in_bytes: 0 },
    { size_in_bytes: "100" },
    { size_in_bytes: 1.5 },
    { workflow_run: { ...baseline.workflow_run, id: 21 } },
    { workflow_run: { ...baseline.workflow_run, head_sha: "b".repeat(40) } },
    { workflow_run: { ...baseline.workflow_run, repository_id: 1 } },
    { workflow_run: { ...baseline.workflow_run, head_repository_id: 1 } },
    { workflow_run: null },
  ]) {
    positive();
    assert.throws(() => assertQualifiedBuildArtifact({ ...baseline, ...mutation }, expected));
  }
  for (const mutation of [
    { artifactId: "../10" },
    { runId: "0" },
    { attempt: "2" },
    { head: "short" },
  ]) {
    positive();
    assert.throws(() => assertQualifiedBuildArtifact(baseline, { ...expected, ...mutation }));
  }
});

test(
  "actual GNU TAR listing counts directories and escapes member newlines",
  {
    skip: process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true",
  },
  async () => {
    const { mkdtemp, mkdir, writeFile, stat, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { assertQualifiedTarBudget } = await import("./qualified-build-budget.mjs");
    const execute = promisify(execFile);
    const temporary = await mkdtemp(join(tmpdir(), "qualified-build-budget-"));
    try {
      const input = join(temporary, "input");
      await mkdir(input);
      await writeFile(join(input, "line\nname.txt"), "real-member");
      const archive = join(temporary, "build.tar");
      await execute("/usr/bin/tar", ["--format=posix", "-cf", archive, "-C", temporary, "input"], {
        timeout: 10000,
      });
      const listed = await execute(
        "/usr/bin/tar",
        ["--list", "--quoting-style=escape", "--file", archive],
        { timeout: 10000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
      );
      assert.equal(assertQualifiedTarBudget((await stat(archive)).size, listed.stdout).members, 2);
      assert.match(listed.stdout, /line\\nname/);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
