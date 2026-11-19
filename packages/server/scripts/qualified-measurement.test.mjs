import assert from "node:assert/strict";
import test from "node:test";

test("directory compiler recipe data binds the full canonical body without granting admission", async () => {
  const { parseDirectoryHelperRecipe } =
    await import("../dist/server/server/execution/directory-recipe.js");
  const { canonicalBuiltinJson } =
    await import("../dist/server/server/execution/builtin-format.js");
  const { createHash } = await import("node:crypto");
  const body = {
    version: 1,
    contract: "ade-directory-helpers-v1",
    initialization: "registration-only",
    qualificationSha256: "1".repeat(64),
    runtimeClosureSha256: "2".repeat(64),
    helperClosureSha256: "3".repeat(64),
    moduleTableSha256: "4".repeat(64),
    compiler: {
      version: 1,
      contract: "ade-directory-entry-v1",
      role: "claim",
      entry: "index.directory.server.ts",
      target: "server",
      client: "none",
    },
  };
  const profileFor = (recipe) => {
    const { compiler, ...profile } = recipe;
    assert.ok(compiler);
    return {
      ...profile,
      recipeSha256: createHash("sha256").update(canonicalBuiltinJson(recipe)).digest("hex"),
    };
  };
  const profile = profileFor(body);
  const original = structuredClone(body);
  const accepted = parseDirectoryHelperRecipe(body, profile, "ade-claim");
  assert.deepEqual(accepted, body);
  assert.notEqual(accepted, body);
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.compiler));
  body.compiler.entry = "index.server.ts";
  assert.equal(accepted.compiler.entry, "index.directory.server.ts");
  const positive = () =>
    assert.deepEqual(parseDirectoryHelperRecipe(original, profile, "ade-claim"), original);
  positive();
  for (const compiler of [
    { ...original.compiler, entry: "index.server.ts" },
    { ...original.compiler, entry: "../index.directory.server.ts" },
    { ...original.compiler, client: "default" },
    { ...original.compiler, target: "client" },
    { ...original.compiler, role: "other" },
    { ...original.compiler, commands: [] },
  ]) {
    positive();
    const changed = { ...original, compiler };
    assert.equal(parseDirectoryHelperRecipe(changed, profileFor(changed), "ade-claim"), null);
  }
  for (const key of [
    "qualificationSha256",
    "runtimeClosureSha256",
    "helperClosureSha256",
    "moduleTableSha256",
  ]) {
    positive();
    const changed = { ...original, [key]: "a".repeat(64) };
    assert.equal(parseDirectoryHelperRecipe(changed, profile, "ade-claim"), null);
    assert.equal(
      parseDirectoryHelperRecipe(original, { ...profile, [key]: "a".repeat(64) }, "ade-claim"),
      null,
    );
  }
  positive();
  for (const value of [
    null,
    {},
    { ...original, helperPermission: true },
    { ...original, recipeSha256: profile.recipeSha256 },
    { ...original, compiler: undefined },
  ])
    assert.equal(parseDirectoryHelperRecipe(value, profile, "ade-claim"), null);
  assert.equal(
    parseDirectoryHelperRecipe(original, { ...profile, recipeSha256: "f".repeat(64) }, "ade-claim"),
    null,
  );
  assert.equal(parseDirectoryHelperRecipe(original, profile, "ade-window-name"), null);
  const window = { ...original, compiler: { ...original.compiler, role: "window" } };
  assert.deepEqual(
    parseDirectoryHelperRecipe(window, profileFor(window), "ade-window-name"),
    window,
  );
  assert.equal(parseDirectoryHelperRecipe(window, profileFor(window), "ade-claim"), null);
  positive();
});

test(
  "fresh verifier bounds actual reads and drains every admitted descriptor before failure",
  {
    skip: process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true",
  },
  async (t) => {
    const { verifyFreshFileRows } =
      await import("../dist/server/server/execution/daemon-verifier.js");
    const fs = await import("node:fs");
    const promises = fs.default.promises;
    const { syncBuiltinESMExports } = await import("node:module");
    const { spawnSync } = await import("node:child_process");
    const { createHash, randomUUID } = await import("node:crypto");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const originalOpen = promises.open;
    const originalRealpath = promises.realpath;
    const root = `/paseo-fresh-files-${randomUUID()}`;
    const temporary = await promises.mkdtemp(path.join(tmpdir(), "fresh-files-"));
    const rows = [];
    const events = [];
    const active = new Set();
    const gates = new Set();
    const pending = new Set();
    let behavior = {};
    let peak = 0;
    function verify(...args) {
      const task = verifyFreshFileRows(...args);
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    }
    function admin(args) {
      const result = spawnSync("sudo", ["-k", "-n", ...args], { encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
    }
    function deferred() {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    function gate() {
      const held = deferred();
      gates.add(held);
      return held;
    }
    async function install(name, size) {
      const source = path.join(temporary, name);
      const handle = await originalOpen(source, "w");
      await handle.truncate(size);
      await handle.close();
      const hash = createHash("sha256");
      const zeros = Buffer.alloc(1024 * 1024);
      for (let remaining = size; remaining > 0; remaining -= zeros.length)
        hash.update(zeros.subarray(0, Math.min(remaining, zeros.length)));
      const row = { path: name, mode: 0o444, size, sha256: hash.digest("hex") };
      admin(["install", "-o", "root", "-g", "root", "-m", "0444", source, path.join(root, name)]);
      return row;
    }
    async function wrappedOpen(file, ...args) {
      const handle = await originalOpen.call(promises, file, ...args);
      if (!String(file).startsWith(`${root}/`)) return handle;
      const name = path.basename(file);
      active.add(handle);
      peak = Math.max(peak, active.size);
      events.push(`open:${name}`);
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      let first = true;
      handle.read = async (...readArgs) => {
        if (first) {
          first = false;
          behavior.entered?.[name]?.resolve();
          await behavior.readGates?.[name]?.promise;
          await behavior.mutate?.(name);
        }
        const result = await read(...readArgs);
        if (behavior.readErrors?.[name]) throw behavior.readErrors[name];
        return result;
      };
      handle.close = async () => {
        behavior.closing?.[name]?.resolve();
        await behavior.closeGates?.[name]?.promise;
        await close();
        active.delete(handle);
        events.push(`close:${name}`);
        if (behavior.closeErrors?.[name]) throw behavior.closeErrors[name];
      };
      return handle;
    }
    async function wrappedRealpath(file, ...args) {
      if (String(file).startsWith(`${root}/`)) events.push(`start:${path.basename(file)}`);
      return originalRealpath.call(promises, file, ...args);
    }
    function reset(next = {}) {
      assert.equal(active.size, 0);
      behavior = next;
      events.length = 0;
      peak = 0;
    }
    try {
      admin(["install", "-d", "-o", "root", "-g", "root", "-m", "0555", root]);
      for (let index = 0; index < 5; index++) rows.push(await install(`small${index}`, 16));
      const mediumA = await install("mediumA", 33 * 1024 * 1024);
      const mediumB = await install("mediumB", 33 * 1024 * 1024);
      const large = await install("large", 65 * 1024 * 1024);
      promises.open = wrappedOpen;
      promises.realpath = wrappedRealpath;
      syncBuiltinESMExports();
      const actualModule = await import("node:fs/promises");
      assert.equal(actualModule.open, wrappedOpen);
      assert.equal(actualModule.realpath, wrappedRealpath);

      await t.test("four actual files maximum and no fifth before all prior closes", async () => {
        reset();
        await verify(root, rows, "manifest");
        assert.ok(peak <= 4);
        for (const row of rows.slice(0, 4))
          assert.ok(events.indexOf(`close:${row.path}`) < events.indexOf("start:small4"));
      });
      await t.test("declared byte budget and large file exclusive", async () => {
        reset();
        await verify(root, [mediumA, mediumB, large, rows[0]], "manifest");
        assert.equal(peak, 1);
        assert.deepEqual(
          events.filter((event) => event.startsWith("start:")),
          ["start:mediumA", "start:mediumB", "start:large", "start:small0"],
        );
        for (const [before, after] of [
          ["mediumA", "mediumB"],
          ["mediumB", "large"],
          ["large", "small0"],
        ])
          assert.ok(events.indexOf(`close:${before}`) < events.indexOf(`start:${after}`));
      });
      await t.test("reverse errors retain index order and await actual sibling close", async () => {
        const heldRead = gate();
        const heldClose = gate();
        const entered = deferred();
        const closing = deferred();
        const firstError = new Error("first original read");
        const secondError = new Error("second original read");
        reset({
          readGates: { small0: heldRead },
          closeGates: { small2: heldClose },
          entered: { small0: entered },
          closing: { small2: closing },
          readErrors: { small0: firstError, small1: secondError },
        });
        let finished = false;
        const task = verify(root, rows, "manifest");
        const observed = task.then(
          () => {
            finished = true;
            return null;
          },
          (error) => {
            finished = true;
            return error;
          },
        );
        await Promise.all([entered.promise, closing.promise]);
        assert.equal(finished, false);
        assert.equal(events.includes("start:small4"), false);
        heldRead.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(finished, false);
        heldClose.resolve();
        const error = await observed;
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [firstError, secondError]);
        assert.equal(error.cause, firstError);
        assert.equal(active.size, 0);
        assert.equal(events.includes("start:small4"), false);
      });
      await t.test("original read and actual-close error both retained", async () => {
        const readError = new Error("actual read failure");
        const closeError = new Error("after actual close failure");
        reset({ readErrors: { small0: readError }, closeErrors: { small0: closeError } });
        await assert.rejects(verify(root, [rows[0]], "manifest"), (error) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, [readError, closeError]);
          assert.equal(error.cause, readError);
          return true;
        });
        reset({ closeErrors: { small0: closeError } });
        await assert.rejects(verify(root, [rows[0]], "manifest"), (error) => error === closeError);
      });
      await t.test(
        "fresh actual bytes, mode and inode races refuse after valid baseline",
        async () => {
          const target = path.join(root, rows[0].path);
          for (const kind of ["bytes", "mode", "inode", "symlink"]) {
            reset();
            await install("small0", 16);
            await verify(root, [rows[0]], "manifest");
            reset({
              mutate: async (name) => {
                if (name !== "small0") return;
                const script =
                  "import os,sys; p,k=sys.argv[1:]; " +
                  "exec({'bytes':\"f=open(p,'r+b'); f.write(b'x'); f.close()\",'mode':\"os.chmod(p,0o644)\",'inode':\"os.unlink(p); f=open(p,'wb'); f.write(bytes(16)); f.close(); os.chmod(p,0o444)\",'symlink':\"os.unlink(p); os.symlink('small1',p)\"}[k])";
                admin(["/usr/bin/python3", "-I", "-c", script, target, kind]);
              },
            });
            await assert.rejects(verify(root, [rows[0]], "manifest"));
            admin(["rm", "-f", target]);
          }
          reset();
          await install("small0", 16);
          await verify(root, [rows[0]], "manifest");
          await assert.rejects(verify(root, [{ ...rows[0], path: "../small0" }], "manifest"));
          await assert.rejects(verify(root, [{ ...rows[0], path: target }], "manifest"));
          await assert.rejects(verify(root, [rows[0]], "external"));
          await verify(root, [{ ...rows[0], path: target }], "external");
        },
      );
    } finally {
      for (const held of gates) held.resolve();
      await Promise.allSettled(pending);
      promises.open = originalOpen;
      promises.realpath = originalRealpath;
      syncBuiltinESMExports();
      assert.equal(active.size, 0, "all admitted actual descriptors must have closed");
      admin(["rm", "-rf", root]);
      await promises.rm(temporary, { recursive: true, force: true });
    }
  },
);
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

test("selected directory import audit refuses native/lazy escapes before code evaluation", async () => {
  const { auditSelectedDirectoryImports } =
    await import("../dist/server/server/execution/directory-import-audit.js");
  const wrap = (body) => `(function(require) { ${body} })`;
  const baseline = wrap('require("node:fs"); require("@getpaseo/plugin/server/ade-helpers");');
  const positive = () =>
    assert.deepEqual(auditSelectedDirectoryImports(baseline, "window"), [
      "@getpaseo/plugin/server/ade-helpers",
      "node:fs",
    ]);
  positive();
  for (const body of [
    'if (false) import("node:fs");',
    'if (!context.managedSource) import("@getpaseo/plugin/server/ade-helpers");',
    'Promise.resolve().then(() => import("node:child_process"));',
    'require("node:url");',
    'require("fs");',
    'require("node:fs/promises");',
    'require("@getpaseo/plugin/internal/ade-directory");',
    'require("node:child_process");',
    'require("node:module");',
    "require(name);",
    "require(`node:fs`);",
    'const loader = require; loader("node:fs");',
    'require.resolve("node:fs");',
    "typeof require;",
    "const meta = import.meta;",
  ]) {
    positive();
    assert.throws(() => auditSelectedDirectoryImports(wrap(body), "window"));
  }
  for (const source of [
    'import fs from "node:fs";',
    "const notFactory = 1;",
    "(async function(require) {})",
    "(function* (require) {})",
    "(function(require, extra) {})",
    wrap("const broken = ;"),
    `${baseline}; process.exit(0);`,
  ]) {
    positive();
    assert.throws(() => auditSelectedDirectoryImports(source, "window"));
  }
  assert.deepEqual(
    auditSelectedDirectoryImports(wrap('require("node:crypto"); require("node:os");'), "claim"),
    ["node:crypto", "node:os"],
  );
  assert.throws(() => auditSelectedDirectoryImports(wrap('require("node:crypto");'), "window"));
  assert.throws(() => auditSelectedDirectoryImports(baseline, "candidate"));
  // Audit is DATA-only: a throwing body is parsed, never evaluated or converted.
  assert.deepEqual(
    auditSelectedDirectoryImports(wrap('throw new Error("must not execute");'), "window"),
    [],
  );
});

test("actual server compiler emits closed literal requires and exposes residual native imports", async () => {
  const { auditSelectedDirectoryImports } =
    await import("../dist/server/server/execution/directory-import-audit.js");
  const { compilePlugin } = await import("../dist/server/server/plugins/compiler-build.js");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const temporary = await mkdtemp(join(tmpdir(), "directory-import-audit-"));
  const server = join(temporary, "server.ts");
  try {
    await writeFile(
      server,
      [
        'export * as fs from "node:fs";',
        'export {runAdeDirectoryOperation} from "@getpaseo/plugin/server/ade-helpers";',
        "export default () => () => {};",
      ].join("\n"),
    );
    const baseline = await compilePlugin({ client: null, server });
    assert.equal(typeof baseline.serverBundle, "string");
    assert.deepEqual(auditSelectedDirectoryImports(baseline.serverBundle, "window"), [
      "@getpaseo/plugin/server/ade-helpers",
      "node:fs",
    ]);
    await writeFile(
      server,
      [
        "export default (context) => {",
        'context.before("agent.open", async () => {',
        'if (!context.managedSource) await import("node:fs");',
        "}); return () => {}; };",
      ].join("\n"),
    );
    const residual = await compilePlugin({ client: null, server });
    assert.equal(typeof residual.serverBundle, "string");
    assert.throws(() => auditSelectedDirectoryImports(residual.serverBundle, "window"), /Native/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
