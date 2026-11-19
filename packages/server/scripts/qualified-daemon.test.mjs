import assert from "node:assert/strict";
import { canonicalBuiltinJson } from "../dist/server/server/execution/builtin-format.js";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import builtinPlugins from "../src/server/execution/builtin-inventory.json" with { type: "json" };

// Disposable Linux CI only. This fixture checks the real v2 acquisition gate;
// native/plugin/controller A-B-A acceptance is owned by the coupled fixture.
const enabled = process.platform === "linux" && process.env.GITHUB_ACTIONS === "true";
function sudo(args) {
  const result = spawnSync("sudo", ["-k", "-n", ...args], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}
function probe(root, race, ambient = {}) {
  const instrumentation = race
    ? `
    import fs from "node:fs";
    import {syncBuiltinESMExports} from "node:module";
    const originalOpen=fs.promises.open;
    let intercepted=false;
    const wrappedOpen=async (...args)=>{
      const handle=await originalOpen(...args);
      if(!intercepted && args[0]===${JSON.stringify(`${root}/role.cjs`)}){
        intercepted=true;
        await fs.promises.writeFile(${JSON.stringify(race.policyPath)},JSON.stringify({schemaVersion:1,qualifications:[]}));
        if(${JSON.stringify(race.restore)}) await fs.promises.writeFile(${JSON.stringify(race.policyPath)},Buffer.from(${JSON.stringify(race.original)},"base64"));
        process.stderr.write("AUTHORITY_RACE_OBSERVED\\n");
      }
      return handle;
    };
    fs.promises.open=wrappedOpen;
    syncBuiltinESMExports();
    if((await import("node:fs/promises")).open!==wrappedOpen) throw new Error("Race fixture did not intercept actual IO");
  `
    : "";
  const source = `${instrumentation}
    Object.assign(process.env,${JSON.stringify(ambient)});
    const {createQualifiedDaemonInvocation}=await import(${JSON.stringify(`${root}/daemon-launcher.mjs`)});
    const result=await createQualifiedDaemonInvocation(${JSON.stringify(root)},"/disposable/home"); console.log(JSON.stringify(result));`;
  return namespaceProbe(root, source, ambient);
}
function namespaceProbe(root, source, ambient = {}, timeout = 20000) {
  // Host remains the original unprivileged caller. Root-owned preparation and
  // cleanup stay OUTSIDE the namespace; the child probe has caps cleared/NNP.
  const manifestPath = `${root}.manifest.json`;
  const manifestRaw = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestRaw);
  const bootstrap = manifest.files.find(
    (row) => row.path === "system-closure/namespace-bootstrap.py",
  );
  assert.ok(bootstrap, "Actual packaged namespace helper missing");
  assert.equal(
    bootstrap.sha256,
    "25ea64e7a238c27931565d5d10faaef927cc85755e69811ee9dc492376178617",
    "Administrative helper must match independently reviewed tracked source",
  );
  assert.equal(bootstrap.size, 57926);
  const script = `${root}.probe.mjs`,
    recipe = `${root}.launch-recipe.json`;
  const temporary = mkdtempSync(path.join(tmpdir(), "paseo-system-probe-"));
  const sourceFile = path.join(temporary, "probe.mjs"),
    recipeFile = path.join(temporary, "recipe.json");
  writeFileSync(sourceFile, source);
  const manifestSha256 = createHash("sha256").update(manifestRaw).digest("hex");
  writeFileSync(
    recipeFile,
    JSON.stringify({
      schemaVersion: 1,
      profile: "linux-ci-qualified-system-namespace-v1",
      distributionRoot: root,
      manifestSha256,
      bootstrap: {
        path: path.join(root, bootstrap.path),
        sha256: bootstrap.sha256,
        size: bootstrap.size,
      },
      harness: {
        path: script,
        sha256: createHash("sha256").update(source).digest("hex"),
        size: Buffer.byteLength(source),
      },
      arguments: [],
      environment: { PATH: "/usr/bin:/bin", GITHUB_ACTIONS: "true", CI: "true" },
    }),
  );
  sudo(["install", "-o", "root", "-g", "root", "-m", "0444", sourceFile, script]);
  sudo(["install", "-o", "root", "-g", "root", "-m", "0444", recipeFile, recipe]);
  try {
    const result = spawnSync(
      "sudo",
      [
        "-k",
        "-n",
        "/usr/bin/python3",
        "-I",
        path.join(root, bootstrap.path),
        "--distribution",
        root,
        "--expected-manifest",
        manifestPath,
        "--expected-manifest-sha256",
        manifestSha256,
        "--launch-recipe",
        recipe,
        "--caller-pid",
        String(process.pid),
      ],
      { encoding: "utf8", timeout, env: { PATH: "/usr/bin:/bin", ...ambient } },
    );
    return result;
  } finally {
    sudo(["rm", "-f", script, recipe]);
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
function ownerInputPlan(inputRoot) {
  const source = `${inputRoot}/repository`,
    config = `${inputRoot}/config`;
  const names = {
    system: `${config}/system`,
    global: `${config}/global`,
    include: `${config}/included`,
    excludes: `${config}/excludes`,
    hooks: `${config}/hooks`,
  };
  const files = {
    "repository/.git/config": "[core]\nrepositoryformatversion = 0\nbare = false\n",
    "repository/.git/HEAD": "ref: refs/heads/main\n",
    "repository/.worktreeinclude": "*.txt\n",
    "repository/.gitignore": "local.txt\n",
    "repository/external.txt": "external.txt",
    "repository/local.txt": "local.txt",
    "repository/keep.txt": "keep.txt",
    "config/system": `[safe]\ndirectory = ${source}\n[core]\nfsmonitor = false\nhooksPath = ${names.hooks}\n`,
    "config/global": `[include]\npath = ${names.include}\n`,
    "config/included": `[core]\nexcludesFile = ${names.excludes}\n`,
    "config/excludes": "external.txt\n",
  };
  return { source, names, files };
}
const ownerInputDirectories = [
  "",
  "config",
  "config/hooks",
  "repository",
  "repository/.git",
  "repository/.git/objects",
  "repository/.git/objects/info",
  "repository/.git/refs",
  "repository/.git/refs/heads",
];
async function writeOwnerInputFiles(temporary, files) {
  for (const directory of ownerInputDirectories)
    await mkdir(path.join(temporary, directory), { recursive: true, mode: 0o755 });
  for (const [name, bytes] of Object.entries(files))
    await writeFile(path.join(temporary, name), bytes, { mode: 0o444 });
}
function assertOwnerInputScope(inputRoot, files) {
  assert.match(inputRoot, /^\/paseo-owner-(?:composition|layout)-[a-f0-9-]+-inputs$/);
  assert.deepEqual(Object.keys(files).sort(), Object.keys(ownerInputPlan(inputRoot).files).sort());
  assert.equal(process.getuid(), userInfo().uid);
  assert.notEqual(process.getuid(), 0, "Fixture reader must remain original nonroot caller");
}
async function assertOwnerInputLayout(inputRoot, files) {
  assertOwnerInputScope(inputRoot, files);
  for (const directory of ownerInputDirectories) {
    const info = await lstat(path.join(inputRoot, directory));
    assert.ok(info.isDirectory());
    assert.equal(info.uid, 0);
    assert.equal(info.mode & 0o777, 0o555);
  }
  for (const [name, bytes] of Object.entries(files)) {
    const info = await lstat(path.join(inputRoot, name));
    assert.ok(info.isFile());
    assert.equal(info.uid, 0);
    assert.equal(info.mode & 0o777, 0o444);
    assert.equal(await readFile(path.join(inputRoot, name), "utf8"), bytes);
  }
}
async function sealOwnerInputLayout(inputRoot, files) {
  assertOwnerInputScope(inputRoot, files);
  // mkdtemp's private 0700 root must not become a root-owned 0500 route
  // after cp -a/chown. Seal only the finite declared fixture paths; the
  // original caller must traverse/read them before the namespace UID drop.
  sudo(["chmod", "0555", ...ownerInputDirectories.map((name) => path.join(inputRoot, name))]);
  sudo(["chmod", "0444", ...Object.keys(files).map((name) => path.join(inputRoot, name))]);
  await assertOwnerInputLayout(inputRoot, files);
}
function ownerConfigReadSet(inputRoot, files) {
  const { source, names } = ownerInputPlan(inputRoot);
  return {
    repository: { cwd: source, gitDirectory: `${source}/.git`, layout: "direct-dotgit-v1" },
    configRoots: { system: names.system, global: names.global, local: `${source}/.git/config` },
    includes: [{ from: names.global, to: names.include }],
    files: Object.entries(files)
      .filter(
        ([name]) =>
          name.startsWith("config/") ||
          name === "repository/.git/config" ||
          name === "repository/.git/HEAD",
      )
      .map(([name, bytes]) => ({
        path: `${inputRoot}/${name}`,
        mode: 292,
        size: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
    protectedAbsent: ["commondir", "config.worktree", "index", "objects/info/alternates", "shallow"]
      .map((name) => `${source}/.git/${name}`)
      .sort(),
  };
}
test(
  "owner input fixture preserves protected config access for original caller",
  { skip: !enabled },
  async () => {
    const { observeFiniteGitConfig, assertFiniteGitConfigUnchanged } =
      await import("../dist/server/server/execution/finite-git-config.js");
    const inputRoot = `/paseo-owner-layout-${randomUUID()}-inputs`;
    const { names, files } = ownerInputPlan(inputRoot);
    const temporary = mkdtempSync(path.join(tmpdir(), "owner-layout-private-"));
    assertOwnerInputScope(inputRoot, files);
    try {
      assert.equal((await lstat(temporary)).mode & 0o777, 0o700);
      await writeOwnerInputFiles(temporary, files);
      sudo(["cp", "-a", temporary, inputRoot]);
      sudo(["chown", "-R", "root:root", inputRoot]);
      sudo(["chmod", "-R", "a-w", inputRoot]);
      assert.equal((await lstat(inputRoot)).uid, 0);
      assert.equal((await lstat(inputRoot)).mode & 0o777, 0o500);
      await assert.rejects(() => readFile(names.system), { code: "EACCES" });
      await sealOwnerInputLayout(inputRoot, files);
      const recipe = ownerConfigReadSet(inputRoot, files);
      const originalProof = await observeFiniteGitConfig(recipe);
      await assertFiniteGitConfigUnchanged(originalProof);
      sudo(["chmod", "0664", names.system]);
      await assert.rejects(() => assertOwnerInputLayout(inputRoot, files));
      await assert.rejects(() => observeFiniteGitConfig(recipe));
      await sealOwnerInputLayout(inputRoot, files);
      await observeFiniteGitConfig(recipe);
      await assert.rejects(
        () => assertFiniteGitConfigUnchanged(originalProof),
        "Mode restoration must not relabel an old read-set as current",
      );
      sudo(["chown", `${process.getuid()}:${process.getgid()}`, names.system]);
      await assert.rejects(() => observeFiniteGitConfig(recipe));
      sudo(["chown", "root:root", names.system]);
      await sealOwnerInputLayout(inputRoot, files);
      await observeFiniteGitConfig(recipe);
    } finally {
      sudo(["rm", "-rf", inputRoot]);
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
test(
  "runtime helper inventory matches finalized closure and rejects changed declarations",
  { skip: !enabled },
  async () => {
    const root = process.env.QUALIFIED_DAEMON_ROOT;
    assert.ok(root && path.isAbsolute(root));
    const { pathToFileURL } = await import("node:url");
    const { assertDaemonHelperInventory } = await import(
      pathToFileURL(path.join(root, "daemon-launcher.mjs")).href
    );
    const { daemonHelperInventory } =
      await import("../dist/server/server/execution/daemon-helper-inventory.js");
    const manifest = JSON.parse(await readFile(`${root}.manifest.json`, "utf8"));
    const bridges = [
      "bridge-assets/identity.json",
      "bridge-assets/v1.metafile.json",
      "bridge-assets/v2.metafile.json",
      "bridge-plugin.bundle.mjs",
      "v2/bridge-plugin.bundle.mjs",
      "v2/state.mjs",
    ];
    function baseline() {
      assert.equal(assertDaemonHelperInventory(manifest), manifest.helperClosureSha256);
      return structuredClone(manifest);
    }
    baseline();
    for (const name of bridges) {
      const file = manifest.files.find((row) => row.path === name);
      assert.ok(file, `Missing actual bridge file ${name}`);
      assert.deepEqual(
        manifest.helperInventory.find((row) => row.path === name),
        file,
        `Missing fixed bridge helper ${name}`,
      );
    }
    const mutations = [
      (value) => {
        value.helperInventory = value.helperInventory.filter((row) => !bridges.includes(row.path));
      },
      (value) => {
        value.helperInventory.find((row) => row.path === bridges[0]).sha256 = "0".repeat(64);
      },
      (value) => {
        value.helperInventory.reverse();
      },
      (value) => {
        value.helperInventory.push({ ...value.helperInventory[0], path: "unknown-helper" });
      },
      (value) => {
        value.helperInventory.push({ ...value.helperInventory[0] });
      },
    ];
    for (const mutate of mutations) {
      const value = baseline();
      mutate(value);
      // Keep the valid canonical digest: ONLY the exact-array guard can reject.
      assert.equal(value.helperClosureSha256, manifest.helperClosureSha256);
      assert.throws(() => assertDaemonHelperInventory(value));
      // Self-consistent changed declarations must not authorize their own rows.
      value.helperClosureSha256 = createHash("sha256")
        .update(JSON.stringify(value.helperInventory))
        .digest("hex");
      assert.throws(() => assertDaemonHelperInventory(value));
    }
    const badDigest = baseline();
    badDigest.helperClosureSha256 = "0".repeat(64);
    assert.deepEqual(badDigest.helperInventory, manifest.helperInventory);
    assert.throws(
      () => assertDaemonHelperInventory(badDigest),
      "Valid rows with wrong digest must fail the digest guard alone",
    );
    const unrelated = {
      path: "bridge-assets/unrecognized.json",
      mode: 292,
      size: 0,
      sha256: "0".repeat(64),
    };
    assert.deepEqual(
      daemonHelperInventory({ files: [unrelated], externalLibraries: [] }),
      [],
      "No arbitrary bridge prefix expansion",
    );
  },
);
test(
  "retained OpenCode bridge uses original built bytes at flattened loader paths",
  { skip: !enabled },
  async () => {
    const root = process.env.QUALIFIED_DAEMON_ROOT;
    assert.ok(root && path.isAbsolute(root));
    const { pathToFileURL, fileURLToPath } = await import("node:url");
    const { loadOpenCodeBridgePluginArtifact } =
      await import("../dist/server/server/agent/providers/opencode/bridge.js");
    const manifest = JSON.parse(await readFile(`${root}.manifest.json`, "utf8"));
    const inputs = JSON.parse(await readFile(path.join(root, "inputs.json"), "utf8"));
    const record = JSON.parse(
      await readFile(path.join(root, "bridge-assets/identity.json"), "utf8"),
    );
    const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    let compilationAttempts = 0;
    const noSourceCompilation = async () => {
      compilationAttempts++;
      throw new Error("Packaged loader must not compile bridge source");
    };
    const moduleUrl = pathToFileURL(path.join(root, "daemon.mjs")).href;
    for (const [version, relative] of [
      [1, "bridge-plugin.bundle.mjs"],
      [2, "v2/bridge-plugin.bundle.mjs"],
    ]) {
      const original = await readFile(
        path.join(
          repository,
          "packages/server/dist/server/server/agent/providers/opencode",
          relative,
        ),
      );
      const loaded = Buffer.from(
        await loadOpenCodeBridgePluginArtifact(moduleUrl, noSourceCompilation, version),
      );
      assert.deepEqual(
        loaded,
        original,
        "Real flattened loader must return unchanged original bundle",
      );
      const expected = manifest.files.find((row) => row.path === relative);
      assert.ok(expected);
      assert.equal(expected.sha256, createHash("sha256").update(loaded).digest("hex"));
      assert.equal(expected.size, loaded.length);
      assert.deepEqual(
        manifest.helperInventory.find((row) => row.path === relative),
        expected,
      );
      assert.equal(record.outputs.find((row) => row.path === relative).sha256, expected.sha256);
      assert.ok(
        inputs.metafiles[relative].outputs[relative].entryPoint.endsWith(
          `opencode/${version === 2 ? "v2/" : ""}bridge-plugin.mjs`,
        ),
      );
      for (const name of Object.keys(inputs.metafiles[relative].inputs))
        assert.ok(
          inputs.sourceInputs.some((row) => row.path === name),
          `Missing actual module input ${name}`,
        );
    }
    const state = await readFile(path.join(root, "v2/state.mjs"));
    assert.deepEqual(
      state,
      await readFile(
        path.join(repository, "packages/server/src/server/agent/providers/opencode/v2/state.mjs"),
      ),
    );
    assert.deepEqual(
      state,
      await readFile(
        path.join(
          repository,
          "packages/server/dist/server/server/agent/providers/opencode/v2/state.mjs",
        ),
      ),
    );
    assert.ok(
      manifest.helperInventory.some(
        (row) =>
          row.path === "v2/state.mjs" &&
          row.sha256 === createHash("sha256").update(state).digest("hex"),
      ),
    );
    assert.ok(
      inputs.sourceInputs.some(
        (row) => row.path === "packages/server/scripts/build-opencode-bridge-plugin.mjs",
      ),
    );
    assert.ok(
      inputs.sourceInputs.some(
        (row) => row.path === "packages/server/src/server/agent/providers/opencode/v2/state.mjs",
      ),
    );
    const missing = mkdtempSync(path.join(tmpdir(), "missing-retained-bridge-"));
    try {
      for (const version of [1, 2])
        await assert.rejects(
          () =>
            loadOpenCodeBridgePluginArtifact(
              pathToFileURL(path.join(missing, "daemon.mjs")).href,
              noSourceCompilation,
              version,
            ),
          /artifact is missing/,
        );
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
    assert.equal(compilationAttempts, 0, "No packaged source-build or alternate asset fallback");
  },
);
test(
  "actual owner refresh overlaps SAME SDK root and original worktree Git hook",
  { skip: !enabled || !process.env.QUALIFIED_OWNER_FIXTURE_ROOT },
  async () => {
    const staged = process.env.QUALIFIED_OWNER_FIXTURE_ROOT;
    assert.ok(staged && path.isAbsolute(staged));
    const root = `/paseo-owner-composition-${randomUUID()}`;
    const account = userInfo().homedir;
    const paseoHome = mkdtempSync(path.join(account, ".paseo-owner-composition-"));
    const policyPath = path.join(
      account,
      ".local/state/djbclark-ade/forks/paseo-qualified-host-policy.json",
    );
    const managedPath = path.join(path.dirname(policyPath), "paseo-managed-plugins.json");
    const prior = (await exists(policyPath)) ? await readFile(policyPath) : null;
    const priorManaged = (await exists(managedPath)) ? await readFile(managedPath) : null;
    const temporary = mkdtempSync(path.join(tmpdir(), "paseo-owner-inputs-"));
    const { source, names, files } = ownerInputPlan(`${root}-inputs`);
    await writeOwnerInputFiles(temporary, files);
    try {
      sudo(["cp", "-a", staged, root]);
      sudo(["cp", `${staged}.manifest.json`, `${root}.manifest.json`]);
      sudo(["cp", "-a", temporary, `${root}-inputs`]);
      sudo(["chown", "-R", "root:root", root, `${root}.manifest.json`, `${root}-inputs`]);
      await sealOwnerInputLayout(`${root}-inputs`, files);
      sudo(["chmod", "0444", `${root}.manifest.json`]);
      await mkdir(path.dirname(policyPath), { recursive: true, mode: 0o700 });
      await writeFile(managedPath, JSON.stringify({ version: 1, plugins: {} }), { mode: 0o600 });
      await chmod(managedPath, 0o600);
      const raw = await readFile(`${root}.manifest.json`),
        manifest = JSON.parse(raw);
      const artifact = manifest.builtinArtifacts.find((row) => row.id === "worktree-include");
      assert.ok(artifact);
      const manifestSha256 = createHash("sha256").update(raw).digest("hex");
      const recipe = {
        contract: "worktree-include-git-config-v1",
        distributionManifestSha256: manifestSha256,
        systemClosureSha256: manifest.systemClosureSha256,
        tools: {
          git: "runtime/git",
          observer: "runtime/git-observer",
          gate: "runtime/git-gate.so",
        },
        argv: {
          lsFiles: ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"],
          checkIgnore: ["check-ignore", "--stdin", "-z"],
        },
        repository: { cwd: source, gitDirectory: `${source}/.git`, layout: "direct-dotgit-v1" },
        environment: {
          PATH: "/usr/bin:/bin",
          HOME: account,
          PASEO_HOME: paseoHome,
          PASEO_MANAGED_PLUGIN_POLICY: managedPath,
          GIT_CONFIG_SYSTEM: names.system,
          GIT_CONFIG_GLOBAL: names.global,
          LC_ALL: "C",
        },
        configRoots: { system: names.system, global: names.global, local: `${source}/.git/config` },
        includes: [{ from: names.global, to: names.include }],
        files: Object.entries(files)
          .filter(
            ([name]) =>
              name.startsWith("config/") ||
              name === "repository/.git/config" ||
              name === "repository/.git/HEAD",
          )
          .map(([name, bytes]) => ({
            path: `${root}-inputs/${name}`,
            mode: 292,
            size: Buffer.byteLength(bytes),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }))
          .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
        protectedAbsent: [
          "commondir",
          "config.worktree",
          "index",
          "objects/info/alternates",
          "shallow",
        ]
          .map((name) => `${source}/.git/${name}`)
          .sort(),
      };
      const finiteGit = {
        schemaVersion: 1,
        recipeSha256: createHash("sha256").update(canonicalBuiltinJson(recipe)).digest("hex"),
        recipe,
      };
      const enrollment = {
        immutableRoot: root,
        immutabilityAdapter: "linux-root-owned-retained-v1",
        distributionBuildId: manifest.distributionBuildId,
        manifestSha256,
        qualificationSha256: "a".repeat(64),
        builtinProfiles: [
          {
            id: "worktree-include",
            sourceSha256: artifact.sourceSha256,
            serverBundleSha256: artifact.serverBundleSha256,
            moduleTableSha256: artifact.moduleTableSha256,
            activityContract: "builtin-in-process-v1",
            profileSha256: createHash("sha256").update("component-owner-sdk-race-v1").digest("hex"),
            finiteGit,
          },
        ],
      };
      const inside = await readFile(
        new URL("./qualified-owner-composition-inside.mjs", import.meta.url),
        "utf8",
      );
      const script =
        inside.replace(
          "export async function runOwnerComposition",
          "async function runOwnerComposition",
        ) +
        `\nawait runOwnerComposition(${JSON.stringify({ root, policyPath, enrollment, paseoHome, source })});\n`;
      // No timer kills a carrier/Git/helper to manufacture component settlement.
      const result = namespaceProbe(root, script, {}, 0);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        component: "actual-owner-sdk-worktree-hook",
        cases: 6,
        qualification: false,
      });
    } finally {
      if (prior) await writeFile(policyPath, prior, { mode: 0o600 });
      else await rm(policyPath, { force: true });
      if (priorManaged) await writeFile(managedPath, priorManaged, { mode: 0o600 });
      else await rm(managedPath, { force: true });
      // The negative cases intentionally leave logical UNKNOWN, not proved
      // settlement. Retain their immutable backing/home until disposable runner
      // teardown; never delete them merely because a component process exited.
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
test(
  "v2 exact retained inventory and policy gates reject changed bytes and FIFOs",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const staged = process.env.QUALIFIED_DAEMON_ROOT;
    assert.ok(staged && path.isAbsolute(staged));
    const root = `/paseo-qualified-daemon-ci-${randomUUID()}`;
    const policyPath = path.join(
      userInfo().homedir,
      ".local/state/djbclark-ade/forks/paseo-qualified-host-policy.json",
    );
    const prior = (await exists(policyPath)) ? await readFile(policyPath) : null;
    const managedPath = path.join(path.dirname(policyPath), "paseo-managed-plugins.json");
    const priorManaged = (await exists(managedPath)) ? await readFile(managedPath) : null;
    const provisionManaged = async () => {
      await writeFile(managedPath, JSON.stringify({ version: 1, plugins: {} }), { mode: 0o600 });
      await chmod(managedPath, 0o600);
    };
    await mkdir(path.dirname(policyPath), { recursive: true, mode: 0o700 });
    const raw = await readFile(`${staged}.manifest.json`);
    const manifest = JSON.parse(raw);
    assert.deepEqual(manifest.builtinPlugins, builtinPlugins);
    const inputs = JSON.parse(await readFile(path.join(staged, "inputs.json"), "utf8"));
    assert.deepEqual(inputs.builtinPlugins, builtinPlugins);
    assert.deepEqual(
      manifest.builtinArtifacts.map((row) => row.id),
      builtinPlugins,
    );
    assert.deepEqual(
      manifest.builtinArtifacts,
      inputs.builtinArtifacts.map((row) => ({
        ...row,
        moduleTableSha256: manifest.moduleTableSha256,
      })),
    );
    assert.equal(
      createHash("sha256").update(canonicalBuiltinJson(manifest.builtinModuleTable)).digest("hex"),
      manifest.moduleTableSha256,
    );
    for (const id of builtinPlugins) {
      const artifact = manifest.builtinArtifacts.find((row) => row.id === id);
      assert.ok(artifact);
      assert.equal(
        createHash("sha256")
          .update(await readFile(path.join(staged, artifact.sourceIdentityPath)))
          .digest("hex"),
        artifact.sourceSha256,
      );
      assert.equal(
        createHash("sha256")
          .update(await readFile(path.join(staged, artifact.factoryPath)))
          .digest("hex"),
        artifact.serverBundleSha256,
      );
      assert.ok(
        (await readFile(path.join(staged, artifact.metafilePath), "utf8")).includes("inputs"),
      );
      const name = `builtin-plugins/${id}/paseo-plugin.json`;
      const file = manifest.files.find((row) => row.path === name);
      assert.ok(file, `Actual builtin source missing: ${id}`);
      assert.equal(
        file.sha256,
        createHash("sha256")
          .update(await readFile(path.join(staged, name)))
          .digest("hex"),
      );
      assert.ok(
        inputs.sourceInputs.some(
          (row) => row.path === `plugins/${id}/paseo-plugin.json` && row.sha256 === file.sha256,
        ),
      );
    }
    const enrollment = {
      immutableRoot: root,
      immutabilityAdapter: "linux-root-owned-retained-v1",
      distributionBuildId: manifest.distributionBuildId,
      manifestSha256: createHash("sha256").update(raw).digest("hex"),
      qualificationSha256: "a".repeat(64),
    };
    const enroll = async () => {
      await writeFile(
        policyPath,
        JSON.stringify({ schemaVersion: 1, qualifications: [enrollment] }),
        { mode: 0o600 },
      );
      await chmod(policyPath, 0o600);
    };
    try {
      sudo(["cp", "-a", staged, root]);
      sudo(["cp", `${staged}.manifest.json`, `${root}.manifest.json`]);
      sudo(["chown", "-R", "root:root", root, `${root}.manifest.json`]);
      sudo(["chmod", "0444", `${root}.manifest.json`]);
      await enroll();
      await provisionManaged();
      const baseline = probe(root);
      assert.equal(baseline.status, 0, baseline.stderr);
      const invocation = JSON.parse(baseline.stdout);
      assert.equal(invocation.closure.runtimeClosureSha256, enrollment.manifestSha256);
      assert.equal(invocation.closure.helperClosureSha256, manifest.helperClosureSha256);
      assert.equal(invocation.closure.qualificationSha256, enrollment.qualificationSha256);
      assert.deepEqual(invocation.args, [`${root}/role.cjs`]);
      assert.deepEqual(invocation.env, {
        HOME: userInfo().homedir,
        PATH: "/usr/bin:/bin",
        PASEO_HOME: "/disposable/home",
        PASEO_MANAGED_PLUGIN_POLICY: managedPath,
      });
      const ambientIgnored = probe(root, undefined, {
        PASEO_MANAGED_PLUGIN_POLICY: "/caller/not-authority.json",
      });
      assert.equal(ambientIgnored.status, 0, ambientIgnored.stderr);
      assert.equal(JSON.parse(ambientIgnored.stdout).env.PASEO_MANAGED_PLUGIN_POLICY, managedPath);
      for (const mutation of ["missing", "public-mode", "invalid-json", "hardlink", "fifo"]) {
        await provisionManaged();
        assert.equal(probe(root).status, 0, "restore valid fixed private policy before negative");
        if (mutation === "missing") await rm(managedPath);
        if (mutation === "public-mode") await chmod(managedPath, 0o644);
        if (mutation === "invalid-json") await writeFile(managedPath, "{");
        if (mutation === "fifo") {
          await rm(managedPath);
          const made = spawnSync("mkfifo", [managedPath], { timeout: 1000 });
          assert.equal(made.status, 0);
        }
        if (mutation === "hardlink") {
          const alias = `${managedPath}.fixture-link`;
          const linked = spawnSync("ln", [managedPath, alias], { timeout: 1000 });
          assert.equal(linked.status, 0);
        }
        const denied = probe(root);
        assert.equal(denied.error, undefined);
        assert.notEqual(denied.status, 0, mutation);
        if (mutation === "fifo") await rm(managedPath);
        await rm(`${managedPath}.fixture-link`, { force: true });
      }
      await provisionManaged();
      assert.equal(probe(root).status, 0, "restore fixed policy after negatives");
      await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, qualifications: [] }));
      assert.notEqual(probe(root).status, 0, "missing enrollment must hold");
      await enroll();
      assert.equal(probe(root).status, 0, "restore baseline before single-member mutation");
      for (const restore of [false, true]) {
        await enroll();
        assert.equal(probe(root).status, 0, "restore positive before authority race");
        const raced = probe(root, {
          policyPath,
          restore,
          original: (await readFile(policyPath)).toString("base64"),
        });
        assert.equal(raced.error, undefined, "authority race must finish within bounded process");
        assert.match(
          raced.stderr,
          /AUTHORITY_RACE_OBSERVED/,
          "must reach actual leaf read, not fail at setup",
        );
        assert.notEqual(
          raced.status,
          0,
          restore
            ? "identical policy bytes restored during scan must fail authority CAS"
            : "revocation during scan must hold",
        );
      }
      await enroll();
      assert.equal(probe(root).status, 0, "restore positive after authority races");
      sudo(["chmod", "0644", `${root}/role.cjs`]);
      sudo(["sh", "-c", 'printf x >> "$1"', "fixture", `${root}/role.cjs`]);
      sudo(["chmod", "0444", `${root}/role.cjs`]);
      assert.notEqual(probe(root).status, 0, "changed retained entry must hold");
      sudo(["cp", `${staged}/role.cjs`, `${root}/role.cjs`]);
      assert.equal(probe(root).status, 0, "restore exact entry before FIFO regression");
      sudo(["rm", `${root}/role.cjs`]);
      sudo(["mkfifo", `${root}/role.cjs`]);
      const fifo = probe(root);
      assert.equal(fifo.error, undefined, "special leaf must reject without probe timeout");
      assert.notEqual(fifo.status, 0);
      sudo(["rm", `${root}/role.cjs`]);
      sudo(["cp", `${staged}/role.cjs`, `${root}/role.cjs`]);
      assert.equal(probe(root).status, 0);
      await rm(policyPath);
      const mkfifo = spawnSync("mkfifo", [policyPath], { timeout: 1000 });
      assert.equal(mkfifo.status, 0);
      const fifoPolicy = probe(root);
      assert.equal(fifoPolicy.error, undefined, "policy FIFO must reject without probe timeout");
      assert.notEqual(fifoPolicy.status, 0);
    } finally {
      await rm(policyPath, { force: true });
      if (prior) await writeFile(policyPath, prior, { mode: 0o600 });
      await rm(managedPath, { force: true });
      await rm(`${managedPath}.fixture-link`, { force: true });
      if (priorManaged) await writeFile(managedPath, priorManaged, { mode: 0o600 });
      sudo(["rm", "-rf", root, `${root}.manifest.json`]);
    }
  },
);

test(
  "retained CLI metadata preserves original bytes and relocated packaged version",
  { skip: !enabled },
  async () => {
    const root = process.env.QUALIFIED_DAEMON_ROOT;
    assert.ok(root && path.isAbsolute(root));
    const { fileURLToPath } = await import("node:url");
    const { assertRetainedCliMetadata } = await import("./retain-qualified-cli-metadata.mjs");
    const { assertDaemonHelperInventory } = await import(path.join(root, "daemon-launcher.mjs"));
    const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const manifest = JSON.parse(await readFile(`${root}.manifest.json`, "utf8"));
    const inputs = JSON.parse(await readFile(path.join(root, "inputs.json"), "utf8"));
    const original = await readFile(path.join(repository, "packages/cli/package.json"));
    const originalVersion = JSON.parse(original.toString("utf8")).version.trim();
    const metadata = await readFile(path.join(root, "cli-package.json"));
    assert.deepEqual(metadata, original);
    await assertRetainedCliMetadata(root, inputs, manifest.files);
    for (const name of ["cli-package.json", "cli-assets/metadata.json", "cli-assets/version.ts"]) {
      const row = manifest.files.find((file) => file.path === name);
      assert.ok(row);
      assert.deepEqual(
        manifest.helperInventory.find((file) => file.path === name),
        row,
      );
      const missing = manifest.helperInventory.filter((file) => file.path !== name);
      assert.throws(() => assertDaemonHelperInventory({ ...manifest, helperInventory: missing }));
      assert.throws(() =>
        assertDaemonHelperInventory({
          ...manifest,
          helperInventory: missing,
          helperClosureSha256: createHash("sha256").update(JSON.stringify(missing)).digest("hex"),
        }),
      );
    }
    const temporary = await (
      await import("node:fs/promises")
    ).mkdtemp(path.join(tmpdir(), "retained-cli-metadata-"));
    const names = ["cli-package.json", "cli-assets/metadata.json", "cli-assets/version.ts"];
    const bytes = new Map(
      await Promise.all(names.map(async (name) => [name, await readFile(path.join(root, name))])),
    );
    const restore = async () => {
      await mkdir(path.join(temporary, "cli-assets"), { recursive: true });
      for (const name of names) {
        await rm(path.join(temporary, name), { force: true });
        await writeFile(path.join(temporary, name), bytes.get(name), { mode: 0o444 });
      }
      await assertRetainedCliMetadata(temporary, inputs, manifest.files);
    };
    try {
      await restore();
      await rm(path.join(temporary, "cli-package.json"));
      await assert.rejects(() => assertRetainedCliMetadata(temporary, inputs, manifest.files));
      await restore();
      await rm(path.join(temporary, "cli-package.json"));
      await writeFile(
        path.join(temporary, "cli-package.json"),
        JSON.stringify({ name: "@getpaseo/cli", version: "fabricated" }),
        { mode: 0o444 },
      );
      await assert.rejects(() => assertRetainedCliMetadata(temporary, inputs, manifest.files));
      await restore();
      const changed = JSON.parse(bytes.get("cli-assets/metadata.json").toString("utf8"));
      changed.relocation.to = 'require("../package.json")';
      await rm(path.join(temporary, "cli-assets/metadata.json"));
      await writeFile(path.join(temporary, "cli-assets/metadata.json"), JSON.stringify(changed), {
        mode: 0o444,
      });
      await assert.rejects(() => assertRetainedCliMetadata(temporary, inputs, manifest.files));
      await restore();
      const changedInputs = structuredClone(inputs);
      changedInputs.sourceInputs.find((row) => row.path === "packages/cli/src/version.ts").sha256 =
        "0".repeat(64);
      await assert.rejects(() =>
        assertRetainedCliMetadata(temporary, changedInputs, manifest.files),
      );
      await restore();
      await rm(path.join(temporary, "cli-package.json"));
      const fifo = spawnSync("/usr/bin/mkfifo", [path.join(temporary, "cli-package.json")], {
        timeout: 5000,
      });
      assert.equal(fifo.status, 0);
      const validatorUrl = new URL("./retain-qualified-cli-metadata.mjs", import.meta.url).href;
      const fifoCheck = `
        import fs from "node:fs";
        const {assertRetainedCliMetadata}=await import(${JSON.stringify(validatorUrl)});
        const inputs=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "inputs.json"))},"utf8"));
        const manifest=JSON.parse(fs.readFileSync(${JSON.stringify(`${root}.manifest.json`)},"utf8"));
        let refused=false;
        try {await assertRetainedCliMetadata(${JSON.stringify(temporary)},inputs,manifest.files);}
        catch(error) {if(error.message!=="Invalid CLI metadata source leaf") throw error; refused=true;}
        if(!refused) throw new Error("FIFO unexpectedly admitted");
      `;
      const bounded = spawnSync(process.execPath, ["--input-type=module", "-e", fifoCheck], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1048576,
      });
      assert.equal(bounded.error, undefined);
      assert.equal(bounded.signal, null);
      assert.equal(bounded.status, 0, bounded.stderr);
      await restore();
      // Execute genuine packaged CLI code with the retained Node, from a different cwd.
      // --version never connects to a daemon. This source regression does not mint
      // a qualified owner or replace the real cli-entry verification/runtime proof.
      const result = spawnSync(
        path.join(root, "runtime/node"),
        [path.join(root, "cli-code.mjs"), "--version"],
        {
          cwd: temporary,
          env: {
            PATH: process.env.PATH,
            HOME: userInfo().homedir,
            PASEO_HOME: path.join(temporary, "home"),
            NO_COLOR: "1",
          },
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 1048576,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), originalVersion);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
