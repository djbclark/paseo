import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import builtinPlugins from "../src/server/execution/builtin-inventory.json" with { type: "json" };

// Disposable Linux CI only. This fixture checks the real v2 acquisition gate;
// native/plugin/controller A-B-A acceptance is owned by the coupled fixture.
const enabled = process.platform === "linux" && process.env.GITHUB_ACTIONS === "true";
function sudo(args) {
  const result = spawnSync("sudo", ["-n", ...args], { encoding: "utf8", timeout: 30000 });
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
    const {createQualifiedDaemonInvocation}=await import(${JSON.stringify(`${root}/daemon-launcher.mjs`)});
    const result=await createQualifiedDaemonInvocation(${JSON.stringify(root)},"/disposable/home"); console.log(JSON.stringify(result));`;
  // Separate bounded process makes FIFO regressions fail instead of hanging CI.
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 20000,
    env: { PATH: "/usr/bin:/bin", ...ambient },
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
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
    assert.deepEqual(manifest.builtinArtifacts, inputs.builtinArtifacts);
    for (const id of builtinPlugins) {
      const artifact = manifest.builtinArtifacts.find((row) => row.id === id);
      assert.ok(artifact);
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
