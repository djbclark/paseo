// Actual Linux CI copies/imports; corruption cases use the DATA verifier only.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  unlink,
  symlink,
  link,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  retainQualifiedPython,
  assertRetainedQualifiedPython,
} from "./retain-qualified-python.mjs";

const execute = promisify(execFile);
const sha = (raw) => createHash("sha256").update(raw).digest("hex");
const limits = { zip: 128 * 1024 * 1024, tar: 512 * 1024 * 1024, members: 10000 };
async function runFdFixture(root, descriptor, caseName) {
  const fixture = path.join(process.env.RUNNER_TEMP, "qualified-python-fd-exec");
  return await new Promise((resolve, reject) => {
    const child = spawn(fixture, [root], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: os.userInfo().homedir },
      stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", descriptor ?? "ignore"],
    });
    let stdout = "",
      stderr = "",
      overflow = false,
      spawnError;
    const collect = (target, data) => {
      if (Buffer.byteLength(target) + data.length > 65536) {
        overflow = true;
        return target;
      }
      return target + data.toString("utf8");
    };
    child.stdout.on("data", (data) => {
      stdout = collect(stdout, data);
    });
    child.stderr.on("data", (data) => {
      stderr = collect(stderr, data);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      const result = { code, signal, stdout, stderr, overflow };
      const raw = JSON.stringify(result) + "\n";
      writeFile(
        path.join(process.env.RUNNER_TEMP, "qualified-python-fd-exec-" + caseName + ".json"),
        raw,
        { flag: "wx", mode: 0o444 },
      ).then(() => {
        if (spawnError) return reject(spawnError);
        else if (overflow) return reject(new Error("FD fixture bounded output exceeded"));
        else return resolve(result);
      }, reject);
    });
  });
}
function compareFdProbe(observation, record, root) {
  const prefix = path.join(root, "python");
  assert.equal(observation.schemaVersion, 2);
  assert.equal(observation.executable, path.join(prefix, "bin/python3"));
  for (const key of ["prefix", "execPrefix", "basePrefix", "baseExecPrefix"])
    assert.equal(observation[key], prefix);
  assert.deepEqual(observation.flags, { isolated: 1, noSite: 1, dontWriteBytecode: 1 });
  assert.deepEqual(observation.path, [
    path.join(prefix, "lib/python312.zip"),
    path.join(prefix, "lib/python3.12"),
    path.join(prefix, "lib/python3.12/lib-dynload"),
  ]);
  assert.deepEqual(observation.build, record.observed.source.build);
  const files = new Set(record.files.map((row) => row.path));
  const relative = (file) => {
    assert.ok(file.startsWith(prefix + "/"));
    return path.relative(root, file);
  };
  for (const row of observation.modules)
    if (!["built-in", "frozen"].includes(row.origin)) assert.ok(files.has(relative(row.origin)));
  const ctypes = observation.modules.find((row) => row.name === "_ctypes");
  assert.equal(path.dirname(ctypes.origin), observation.extensionDirectory);
  assert.ok(observation.nativeMapFiles.includes(ctypes.origin));
  for (const key of ["stdlib", "platstdlib", "extensionDirectory"])
    assert.equal(relative(observation[key]), record.observed.relocated[key]);
  const normalize = (file) => (file.startsWith(prefix + "/") ? relative(file) : file);
  assert.deepEqual(
    observation.modules.map((row) => ({
      ...row,
      origin: ["built-in", "frozen"].includes(row.origin) ? row.origin : relative(row.origin),
    })),
    record.observed.relocated.modules,
  );
  assert.deepEqual(
    observation.nativeMapFiles.map(normalize),
    record.observed.relocated.nativeMapFiles,
  );
}
async function fdExecEvidence(root, retained, record) {
  const python = path.join(root, "python/bin/python3");
  const handle = await open(
    python,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const evidence = {
    kind: "retained-python-fd-exec-CI-DATA",
    qualification: false,
    productionAuthority: false,
    controls: [],
  };
  for (const [role, file] of [
    ["source", path.resolve("packages/server/scripts/qualified-python-fd-exec.c")],
    ["compiled", path.join(process.env.RUNNER_TEMP, "qualified-python-fd-exec")],
    ["compiler", "/usr/bin/gcc"],
  ]) {
    const resolved = await realpath(file);
    const raw = await readFile(resolved);
    evidence[role] = {
      path: file,
      realpath: resolved,
      mode: (await lstat(resolved)).mode & 0o777,
      size: raw.length,
      sha256: sha(raw),
    };
  }
  await writeFile(
    path.join(process.env.RUNNER_TEMP, "qualified-python-fd-exec-build.json"),
    JSON.stringify({
      source: evidence.source,
      compiled: evidence.compiled,
      compiler: evidence.compiler,
    }) + "\n",
    { flag: "wx", mode: 0o444 },
  );
  try {
    const original = await handle.stat({ bigint: true });
    const identity = retained.files.find((row) => row.path === "python/bin/python3");
    assert.equal(original.nlink, 1n);
    assert.equal(Number(original.mode & 0o7777n), 0o555);
    assert.equal(sha(await handle.readFile()), identity.sha256);
    const result = await runFdFixture(root, handle.fd, "positive");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    const messages = result.stderr
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    assert.equal(messages.length, 2);
    const descriptor = messages[0];
    assert.equal(descriptor.kind, "python-fd-exec-descriptor");
    assert.equal(descriptor.fd, 5);
    assert.equal(descriptor.cloexec, true);
    assert.equal(descriptor.dev, String(original.dev));
    assert.equal(descriptor.ino, String(original.ino));
    assert.equal(descriptor.mode, 0o555);
    assert.equal(descriptor.size, Number(original.size));
    assert.equal(descriptor.home, os.userInfo().homedir);
    const observation = JSON.parse(result.stdout);
    compareFdProbe(observation, record, root);
    evidence.originalInterpreter = identity;
    evidence.descriptor = descriptor;
    evidence.probe = observation;
    evidence.sysconfig = messages[1];
    assert.equal(messages[1].kind, "retained-python-sysconfig-source-diagnostic");
    const after = await handle.stat({ bigint: true });
    for (const key of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"])
      assert.equal(after[key], original[key]);
  } finally {
    await handle.close();
  }
  const wrong = path.join(path.dirname(root), "wrong-python-image");
  await writeFile(wrong, "not an ELF or shebang image\n", { flag: "wx", mode: 0o555 });
  const bad = await open(wrong, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const result = await runFdFixture(root, bad.fd, "wrong");
    assert.equal(result.code, 126);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr.trim().split("\n").at(-1));
    assert.equal(error.phase, "execveat");
    assert.equal(error.errno, 8);
    evidence.controls.push({ kind: "wrong-fd-no-path-fallback", ...result });
  } finally {
    await bad.close();
  }
  const closed = await runFdFixture(root, undefined, "closed");
  assert.equal(closed.code, 126);
  assert.equal(closed.signal, null);
  assert.equal(closed.stdout, "");
  const error = JSON.parse(closed.stderr.trim());
  assert.equal(error.phase, "cloexec");
  assert.equal(error.errno, 9);
  evidence.controls.push({ kind: "closed-fd-no-path-fallback", ...closed });
  const raw = JSON.stringify(evidence) + "\n";
  assert.ok(Buffer.byteLength(raw) <= 131072);
  await writeFile(
    path.join(process.env.RUNNER_TEMP, "qualified-python-fd-exec-evidence.json"),
    raw,
    { flag: "wx", mode: 0o444 },
  );
  await assertRetainedQualifiedPython(root, retained.record);
}
async function unlinkIfPresent(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function overwrite(file, raw) {
  await chmod(file, 0o644);
  await writeFile(file, raw);
  await chmod(file, 0o444);
}
async function changeDirectory(directory, operation) {
  await chmod(directory, 0o755);
  try {
    return await operation();
  } finally {
    await chmod(directory, 0o555);
  }
}
function mutateAliasRecord(mutated, kind) {
  const alias = mutated.sourceFiles.find((r) => r.sourceLink);
  assert.ok(alias, "actual fixed-source alias measured");
  if (kind === "alias-missing-link") delete alias.sourceLink;
  if (kind === "alias-target") alias.sourceLink.target = "../escape";
  if (kind === "alias-mode") alias.sourceLink.mode = 0o444;
  if (kind === "alias-path") alias.sourceLink.resolvedSourcePath = "/tmp/target";
  if (kind === "alias-abi") mutated.observed.source.build.MULTIARCH = "aarch64-linux-gnu";
  if (kind === "alias-extra") alias.sourceLink.permission = true;
  if (kind === "alias-other-row")
    mutated.sourceFiles[0].sourceLink = structuredClone(alias.sourceLink);
  if (kind === "alias-missing-target")
    mutated.sourceFiles = mutated.sourceFiles.filter(
      (r) => r.sourcePath !== alias.sourceLink.resolvedSourcePath,
    );
  if (kind === "missing-source") mutated.sourceFiles.pop();
}
const materializationMutations = {
  "missing-materialization": (row) => {
    delete row.sourceMaterialization;
  },
  "wrong-kind": (row) => {
    row.sourceMaterialization.kind = "other";
  },
  "swapped-kind": (row) => {
    row.sourceMaterialization.kind =
      row.sourceMaterialization.kind === "sitecustomize" ? "config-libpython" : "sitecustomize";
  },
  "wrong-hop": (row) => {
    row.sourceMaterialization.hops[0].target = "../wrong";
  },
  "extra-hop": (row) => {
    row.sourceMaterialization.hops.push(row.sourceMaterialization.hops[0]);
  },
  "changed-link": (row) => {
    row.sourceMaterialization.hops[0].identity = "0:0:0:0:0:0:0:0:0";
  },
  "changed-ancestor": (row) => {
    row.sourceMaterialization.ancestors[0].mode = 0o777;
  },
  "changed-target": (row) => {
    row.sourceMaterialization.target.sha256 = "0".repeat(64);
  },
  "target-mode": (row) => {
    row.sourceMaterialization.target.mode = 0o666;
  },
  "target-size": (row) => {
    row.sourceMaterialization.target.size++;
  },
  "target-path": (row) => {
    row.sourceMaterialization.target.path = "/tmp/target";
  },
  "retained-digest": (row) => {
    row.sourceMaterialization.retained.sha256 = "0".repeat(64);
  },
  "unknown-row": (row) => {
    row.sourceMaterialization.authorized = true;
  },
  "source-path": (row) => {
    row.sourceMaterialization.sourcePath = "/tmp/source";
  },
  "source-link-mix": (row) => {
    row.sourceLink = { target: "any" };
  },
  "missing-provenance": (row) => {
    row.sourceMaterialization.provenance.pop();
  },
  "wrong-owner": (row) => {
    row.sourceMaterialization.provenance[0].owners[0].permission = true;
  },
  "wrong-abi": (row) => {
    row.sourceMaterialization.abi.build.MULTIARCH = "aarch64-linux-gnu";
  },
  "wrong-elf": (row) => {
    row.sourceMaterialization.evidence.elfs[0].sha256 = "0".repeat(64);
  },
  "wrong-source-identity": (row) => {
    row.sourceMaterialization.evidence.sourceFiles[0].identity = "0:0:0:0:0:0:0:0:0";
  },
};
const probeMutations = {
  "old-record-version": (record) => {
    record.schemaVersion = 1;
    record.kind = "retained-cpython-layout-v1";
  },
  "old-observation-version": (record) => {
    record.observed.relocated.schemaVersion = 1;
  },
  "compiled-destshared": (record) => {
    record.observed.relocated.build.DESTSHARED = "python/lib/python3.12/lib-dynload";
  },
  "compiled-build-drift": (record) => {
    record.observed.relocated.build.CONFIG_ARGS += " changed";
  },
  "missing-ctypes": (record) => {
    record.observed.relocated.modules = record.observed.relocated.modules.filter(
      (row) => row.name !== "_ctypes",
    );
  },
  "outside-ctypes": (record) => {
    record.observed.relocated.modules.find((row) => row.name === "_ctypes").origin =
      "/usr/lib/python3.12/lib-dynload/_ctypes.so";
  },
  "missing-extension-map": (record) => {
    const origin = record.observed.relocated.modules.find((row) => row.name === "_ctypes").origin;
    record.observed.relocated.nativeMapFiles = record.observed.relocated.nativeMapFiles.filter(
      (name) => name !== origin,
    );
  },
  "extension-directory": (record) => {
    record.observed.relocated.extensionDirectory = record.layout.stdlib;
  },
};
test(
  "fixed source retention, relocation and strict preexec DATA refusals",
  { timeout: 240000 },
  async (t) => {
    assert.equal(process.platform, "linux");
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    const parent = await mkdtemp(path.join(os.tmpdir(), "python-retention-ci-"));
    const root = path.join(parent, "distribution");
    await mkdir(root);
    const retained = await retainQualifiedPython(root);
    const record = await assertRetainedQualifiedPython(root, retained.record);
    const recordFile = path.join(root, retained.record.path);
    const recordRaw = await readFile(recordFile);
    assert.equal(record.qualification, false);
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.kind, "retained-cpython-layout-v2");
    assert.equal(record.observed.source.schemaVersion, 2);
    assert.equal(record.observed.relocated.schemaVersion, 2);
    assert.equal(record.observed.source.build.DESTSHARED, "/usr/lib/python3.12/lib-dynload");
    assert.deepEqual(record.observed.source.build, record.observed.relocated.build);
    const actualExtension = record.observed.relocated.modules.find((row) => row.name === "_ctypes");
    assert.equal(path.dirname(actualExtension.origin), record.layout.extensionDirectory);
    assert.ok(record.observed.relocated.nativeMapFiles.includes(actualExtension.origin));
    const materialized = record.sourceFiles.filter((row) => row.sourceMaterialization);
    assert.equal(materialized.length, 2);
    for (const row of materialized) {
      const value = row.sourceMaterialization;
      assert.equal(row.mode, 0o444);
      assert.equal(row.sourceMode, 0o644);
      assert.equal(row.size, value.target.size);
      assert.equal(row.sha256, value.target.sha256);
      assert.ok(value.provenance.some((entry) => entry.path === value.target.path));
      assert.ok(
        value.evidence.sourceFiles.some(
          (entry) => entry.path === record.source.stdlib + "/site.py",
        ),
      );
      assert.deepEqual(value.retained, {
        path: row.path,
        mode: row.mode,
        size: row.size,
        sha256: row.sha256,
      });
      assert.equal((await lstat(path.join(root, row.path))).isSymbolicLink(), false);
    }
    console.log(
      JSON.stringify({
        kind: "retained-python-per-file-source-evidence",
        qualification: false,
        rows: materialized.map((row) => row.sourceMaterialization),
      }),
    );
    assert.deepEqual(Object.keys(retained).sort(), ["files", "record", "sourceInputs"]);
    assert.equal(retained.files.filter((r) => r.path === retained.record.path).length, 1);
    assert.ok(!record.files.some((r) => r.path === retained.record.path));
    assert.equal(record.source.requestedExecutable, "/usr/bin/python3");
    assert.ok(record.source.packageProvenance.length);
    assert.deepEqual(record.layout.argvFlags, ["-I", "-S", "-B"]);
    assert.equal(record.observed.relocated.prefix, "python");
    assert.ok(record.observed.relocated.path.every((p) => p.startsWith("python/")));
    assert.ok(
      record.observed.relocated.modules.some(
        (r) => r.name === "encodings" && r.origin.startsWith("python/"),
      ),
    );
    assert.ok(
      record.observed.relocated.modules.some(
        (r) => r.name === "_ctypes" && r.origin.startsWith(record.layout.extensionDirectory + "/"),
      ),
    );
    assert.ok(record.observed.relocated.modules.some((r) => r.origin === "built-in"));
    assert.ok(record.observed.relocated.modules.some((r) => r.origin === "frozen"));
    assert.ok(
      record.observed.relocated.nativeMapFiles.some((p) => p.startsWith("/usr/")),
      "external mapped ELF remains explicit future closure input",
    );
    const interpreter = record.sourceFiles.find((r) => r.path === "python/bin/python3");
    assert.equal(interpreter.mode, 0o555);
    assert.ok(
      interpreter.sourceMode & 0o200,
      "actual source write bit is not normalized as retained mode",
    );
    assert.ok(
      record.files.every(
        (r) =>
          !r.path.endsWith(".pyc") && !r.path.endsWith(".pyo") && !r.path.includes("/__pycache__/"),
      ),
    );
    assert.equal((await lstat(path.join(root, "python"))).mode & 0o777, 0o555);
    await t.test("existing destination refuses without replacing paid bytes", async () => {
      await assert.rejects(retainQualifiedPython(root), /destination already exists/);
      assert.deepEqual(await readFile(recordFile), recordRaw);
    });
    for (const name of [
      "python/bin/python3",
      "python/provenance/probe.py",
      record.layout.stdlib + "/os.py",
      ...materialized.map((row) => row.path),
      record.layout.stdlib + "/encodings/__init__.py",
      record.files.find(
        (r) =>
          r.path.startsWith(record.layout.extensionDirectory + "/") &&
          path.basename(r.path).startsWith("_ctypes."),
      ).path,
    ]) {
      await t.test("corrupt bytes refuse without executing suspect code: " + name, async () => {
        const file = path.join(root, name),
          original = await readFile(file),
          info = await lstat(file);
        const corrupt = Buffer.from(original);
        corrupt[0] ^= 1;
        try {
          await chmod(file, 0o644);
          await writeFile(file, corrupt);
          await chmod(file, info.mode & 0o777);
          await assert.rejects(
            assertRetainedQualifiedPython(root, retained.record),
            /retained bytes/,
          );
        } finally {
          await chmod(file, 0o644);
          await writeFile(file, original);
          await chmod(file, info.mode & 0o777);
        }
      });
    }
    for (const kind of [
      "missing",
      "symlink",
      "hardlink",
      "mode",
      "undeclared",
      "absent",
      "unsealed-directory",
    ]) {
      await t.test("closed payload refuses " + kind, async () => {
        const file = path.join(root, record.layout.stdlib, "os.py"),
          directory = path.dirname(file),
          original = await readFile(file);
        const extra = path.join(directory, "retention-extra.py");
        try {
          if (kind === "missing") await changeDirectory(directory, () => unlink(file));
          if (kind === "symlink")
            await changeDirectory(directory, async () => {
              await unlink(file);
              await symlink("/usr/lib/" + path.basename(record.layout.stdlib) + "/os.py", file);
            });
          if (kind === "hardlink") await changeDirectory(directory, () => link(file, extra));
          if (kind === "mode") await chmod(file, 0o644);
          if (kind === "undeclared")
            await changeDirectory(directory, () => writeFile(extra, "unknown\n", { mode: 0o444 }));
          if (kind === "absent")
            await changeDirectory(path.join(root, "python"), () =>
              writeFile(path.join(root, "python/pyvenv.cfg"), "home=/usr\n", { mode: 0o444 }),
            );
          if (kind === "unsealed-directory") await chmod(directory, 0o755);
          await assert.rejects(assertRetainedQualifiedPython(root, retained.record));
        } finally {
          await chmod(directory, 0o755);
          for (const p of [file, extra]) await unlinkIfPresent(p);
          await writeFile(file, original, { mode: 0o444 });
          await chmod(directory, 0o555);
          if (kind === "absent")
            await changeDirectory(path.join(root, "python"), () =>
              unlink(path.join(root, "python/pyvenv.cfg")),
            );
        }
      });
    }
    for (const kind of [
      "raw-hash",
      "unknown",
      "duplicate",
      "order",
      "escape",
      "source-mode",
      "source-map",
      "alias-missing-link",
      "alias-target",
      "alias-mode",
      "alias-path",
      "alias-abi",
      "alias-extra",
      "alias-other-row",
      "alias-missing-target",
      "missing-source",
      "layout",
      "flags",
      "prefix",
      "host-module",
      "budgets",
      "bytecode",
    ]) {
      await t.test("strict record refuses " + kind, async () => {
        const mutated = structuredClone(record);
        if (kind === "unknown") mutated.authorized = true;
        if (kind === "duplicate") mutated.files.push(mutated.files[0]);
        if (kind === "order") mutated.files.reverse();
        if (kind === "escape") mutated.files[0].path = "../outside";
        if (kind === "source-mode") mutated.sourceFiles[0].sourceMode = 0o777;
        if (kind === "source-map") mutated.sourceFiles[0].sourcePath = "/tmp/source";
        mutateAliasRecord(mutated, kind);
        if (kind === "layout") mutated.layout.executable = "/usr/bin/python3";
        if (kind === "flags") mutated.layout.argvFlags = ["-S"];
        if (kind === "prefix") mutated.observed.relocated.prefix = "/usr";
        if (kind === "host-module")
          mutated.observed.relocated.modules.find((r) => r.name === "encodings").origin =
            "/usr/lib/python3/encodings/__init__.py";
        if (kind === "budgets") mutated.budgets.tarLimit++;
        if (kind === "bytecode") mutated.files[0].path += ".pyc";
        const raw = Buffer.from(JSON.stringify(mutated) + "\n");
        if (kind === "raw-hash") raw[raw.length - 1] = 0x20;
        try {
          await overwrite(recordFile, raw);
          const expectation =
            kind === "raw-hash"
              ? retained.record
              : { path: retained.record.path, mode: 0o444, size: raw.length, sha256: sha(raw) };
          await assert.rejects(
            assertRetainedQualifiedPython(root, expectation),
            kind === "raw-hash" ? /raw record identity/ : undefined,
          );
        } finally {
          await overwrite(recordFile, recordRaw);
        }
      });
    }
    for (const [kind, mutate] of Object.entries(probeMutations)) {
      await t.test("v2 observation refuses " + kind, async () => {
        const changed = structuredClone(record);
        mutate(changed);
        const raw = Buffer.from(JSON.stringify(changed) + "\n");
        try {
          await overwrite(recordFile, raw);
          await assert.rejects(
            assertRetainedQualifiedPython(root, {
              ...retained.record,
              size: raw.length,
              sha256: sha(raw),
            }),
          );
        } finally {
          await overwrite(recordFile, recordRaw);
        }
      });
    }
    for (const [kind, mutate] of Object.entries(materializationMutations)) {
      for (const selected of materialized) {
        await t.test(
          "strict materialization refuses " + kind + " on " + selected.sourceMaterialization.kind,
          async () => {
            const changed = structuredClone(record);
            const row = changed.sourceFiles.find((entry) => entry.path === selected.path);
            mutate(row);
            const raw = Buffer.from(JSON.stringify(changed) + "\n");
            try {
              await overwrite(recordFile, raw);
              await assert.rejects(
                assertRetainedQualifiedPython(root, {
                  ...retained.record,
                  size: raw.length,
                  sha256: sha(raw),
                }),
              );
            } finally {
              await overwrite(recordFile, recordRaw);
            }
          },
        );
      }
    }
    await t.test("expected record path cannot select an arbitrary manifest", async () => {
      await assert.rejects(
        assertRetainedQualifiedPython(root, { ...retained.record, path: "other.json" }),
        /fixed record/,
      );
    });
    await t.test(
      "actual original retained interpreter FD5 execveat and refusal controls",
      async () => {
        await fdExecEvidence(root, retained, record);
      },
    );
    await t.test(
      "standalone actual TAR+ZIP budgets, not combined producer acceptance",
      async () => {
        const archive = path.join(parent, "python.tar");
        await execute(
          "/usr/bin/tar",
          [
            "--format=posix",
            "--sort=name",
            "--numeric-owner",
            "--pax-option=delete=atime,delete=ctime",
            "-cf",
            archive,
            "-C",
            root,
            "python",
          ],
          { timeout: 60000 },
        );
        assert.ok((await lstat(archive)).size <= limits.tar);
        // Trusted fixed test code only; uses source Python for archive DATA, no code
        // from an artifact and no interpreter/env override to production helper.
        const script = path.join(parent, "archive-data.py");
        await writeFile(
          script,
          "import sys,zipfile,tarfile\np=sys.argv[1]\nwith tarfile.open(p) as t:\n assert len(t.getmembers())<=10000\nwith zipfile.ZipFile(p+'.zip','x',zipfile.ZIP_DEFLATED) as z:\n z.write(p,'python.tar')\n",
          { mode: 0o444 },
        );
        await execute("/usr/bin/python3", ["-I", "-S", "-B", script, archive], {
          timeout: 60000,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        });
        assert.ok((await lstat(archive + ".zip")).size <= limits.zip);
        console.log(
          JSON.stringify({
            kind: "retained-python-CI-DATA",
            qualification: false,
            version: record.source.version,
            recordSha256: retained.record.sha256,
            files: retained.files.length,
            tarBytes: (await lstat(archive)).size,
            zipBytes: (await lstat(archive + ".zip")).size,
            combinedProducerFit: false,
          }),
        );
      },
    );
    await assertRetainedQualifiedPython(root, retained.record);
  },
);

test(
  "complete output budget rejects oversize existing input before Python capture",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "python-retention-bound-"));
    const fd = await open(path.join(root, "oversize"), "wx", 0o444);
    await fd.truncate(512 * 1024 * 1024 + 1);
    await fd.close();
    await assert.rejects(retainQualifiedPython(root), /unsafe regular input/);
  },
);
