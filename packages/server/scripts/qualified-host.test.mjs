import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, unlink, writeFile, stat, lstat } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import path from "node:path";
import { buildQualifiedHost } from "./build-qualified-host.mjs";
import { finalizeQualifiedHost } from "./finalize-qualified-host.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sudo(...args) {
  execFileSync("sudo", ["-n", ...args], { timeout: 30000 });
}
function waitExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}
function observe(child, challenge = randomUUID()) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Host observation timed out"));
    }, 30000);
    const message = (value) => {
      if (value.challenge === challenge) {
        cleanup();
        resolve(value);
      }
    };
    const exit = () => {
      cleanup();
      reject(new Error("Host exited before observation"));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exit);
    }
    child.on("message", message);
    child.on("exit", exit);
    child.send({ challenge });
  });
}
function accepts(child, value, expected, challenge, incarnation) {
  return (
    value.challenge === challenge &&
    value.evidence.process.pid === child.pid &&
    value.evidence.qualificationManifestSha256 === expected.manifestSha256 &&
    (!incarnation || value.evidence.process.processStartToken === incarnation) &&
    value.supported
  );
}

test(
  "real retained Linux host A/B and negative launch qualification",
  { timeout: 300000 },
  async () => {
    assert.equal(
      process.env.GITHUB_ACTIONS,
      "true",
      "Privileged fixtures run only in disposable CI",
    );
    assert.equal(process.platform, "linux");
    assert.notEqual(process.getuid(), 0);
    const id = randomUUID();
    const stage = path.resolve(`.qualified-host-ci-${id}`);
    // Do not inherit hosted-runner tool-directory permissions (notably /opt).
    // This unique directory and its children are the only privileged fixture writes.
    const retained = `/paseo-qualified-host-ci-${id}`;
    const policy = path.join(
      userInfo().homedir,
      ".local/state/djbclark-ade/forks/paseo-qualified-host-policy.json",
    );
    let previous;
    try {
      previous = await readFile(policy);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const children = [];
    const writePolicy = async (qualifications) => {
      await mkdir(path.dirname(policy), { recursive: true, mode: 0o700 });
      await writeFile(policy, JSON.stringify({ schemaVersion: 1, qualifications }), {
        mode: 0o600,
      });
    };
    const launch = (root, env = {}) => {
      const child = spawn(`${root}/runtime/node`, [`${root}/role.cjs`], {
        env: { PATH: "/usr/bin:/bin", ...env },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      child.stderr.resume();
      children.push(child);
      return child;
    };
    const rejected = async (root, env) => {
      const child = launch(root, env);
      let diagnostic = "";
      child.stderr.on("data", (chunk) => {
        diagnostic += chunk.toString();
      });
      let timer;
      try {
        const result = await Promise.race([
          new Promise((resolve) =>
            child.once("close", (code, signal) => resolve({ code, signal })),
          ),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Unsupported host did not exit")), 10000);
          }),
        ]);
        assert.notEqual(result.code, 0);
        return diagnostic;
      } finally {
        clearTimeout(timer);
      }
    };
    async function ancestry(file) {
      const rows = [];
      for (let current = file; ; current = path.dirname(current)) {
        const observed = await lstat(current);
        rows.push({
          path: current,
          uid: observed.uid,
          gid: observed.gid,
          mode: (observed.mode & 0o777).toString(8),
          symlink: observed.isSymbolicLink(),
        });
        if (current === path.dirname(current)) break;
      }
      return rows;
    }
    try {
      console.error("Previous fixture ancestor evidence", JSON.stringify(await ancestry("/opt")));
      sudo("mkdir", "-p", retained);
      sudo("chown", `${process.getuid()}:${process.getgid()}`, retained);
      const qualifications = [];
      for (const buildId of ["A", "B"]) {
        const root = path.join(stage, buildId);
        await buildQualifiedHost({
          outDir: root,
          distributionBuildId: `distribution-${buildId}`,
          roleBuildId: `role-${buildId}`,
        });
        await finalizeQualifiedHost(root, process.execPath);
        // Finalize paths/library inventory again at the immutable retained location.
        sudo("cp", "-R", root, `${retained}/${buildId}`);
        sudo("chown", "-R", `${process.getuid()}:${process.getgid()}`, `${retained}/${buildId}`);
        sudo("chmod", "u+w", `${retained}/${buildId}`, `${retained}/${buildId}/runtime`);
        const enrolled = await finalizeQualifiedHost(`${retained}/${buildId}`, process.execPath);
        sudo(
          "chown",
          "-R",
          "root:root",
          `${retained}/${buildId}`,
          `${retained}/${buildId}.manifest.json`,
        );
        qualifications.push(enrolled);
      }
      sudo("chown", "root:root", retained);
      await writePolicy(qualifications);
      await symlink(`${retained}/A`, path.join(stage, "visible"));
      const launcher = createRequire(import.meta.url)(`${retained}/A/launcher.cjs`);
      const retainedAncestry = await ancestry(`${retained}/A`);
      console.error("Retained fixture ancestry evidence", JSON.stringify(retainedAncestry));
      for (const observed of retainedAncestry) {
        assert.equal(observed.uid, 0, `non-root fixture ancestor: ${observed.path}`);
        assert.equal(
          parseInt(observed.mode, 8) & 0o022,
          0,
          `writable fixture ancestor: ${observed.path}`,
        );
        assert.equal(observed.symlink, false);
      }
      const invocation = launcher.createQualifiedHostInvocation(`${retained}/A`);
      assert.deepEqual(invocation.env, { PATH: "/usr/bin:/bin" });
      const childA = launcher.launchQualifiedPluginHost(`${retained}/A`);
      childA.stderr.resume();
      children.push(childA);
      const challengeA = randomUUID();
      const a = await observe(childA, challengeA);
      assert.equal(a.bindingProbe, true);
      assert.equal(a.rejectedPrivateImports, true);
      assert.equal(a.rejectedRelabel, true);
      assert.equal(a.rejectedJsonCapability, true);
      assert.equal(a.evidence.distributionBuildId, "distribution-A");
      assert.ok(accepts(childA, a, qualifications[0], challengeA));
      await unlink(path.join(stage, "visible"));
      await symlink(`${retained}/B`, path.join(stage, "visible"));
      const stillA = await observe(childA);
      assert.deepEqual(stillA.evidence, a.evidence);
      assert.equal(stillA.bindingProbe, true);
      const childB = launch(`${retained}/B`);
      const b = await observe(childB);
      assert.equal(b.evidence.distributionBuildId, "distribution-B");
      assert.equal(b.bindingProbe, true);
      assert.notEqual(a.evidence.process.processStartToken, b.evidence.process.processStartToken);
      assert.equal(
        accepts(childB, a, qualifications[1], challengeA),
        false,
        "old child ACK cannot name new process",
      );
      assert.equal(accepts(childA, a, qualifications[0], "different-challenge"), false);
      assert.equal(accepts(childA, a, qualifications[0], challengeA, "stale-incarnation"), false);
      await writePolicy([qualifications[1]]);
      const revokedA = await observe(childA);
      assert.equal(revokedA.supported, false);
      assert.deepEqual(revokedA.evidence, a.evidence);
      await rejected(`${retained}/A`); // Expected B cannot relabel new A either.
      await writePolicy(qualifications);
      await rejected(`${retained}/A`, { NODE_OPTIONS: "--no-warnings" });
      await rejected(`${retained}/A`, { NODE_PATH: "/tmp" });
      await rejected(`${retained}/A`, { ESBUILD_BINARY_PATH: "/bin/false" });
      await rejected(path.join(stage, "A")); // Mutable source/staging root.
      const manifestFile = `${retained}/A.manifest.json`;
      const originalManifest = await readFile(manifestFile, "utf8");
      const manifest = JSON.parse(originalManifest);
      for (const patch of [
        { helpers: [{ helperId: "unqualified", artifactId: "wrong-interpreter" }] },
        { externalLibraries: [] },
        { role: "compiler" },
        { bindingKeys: ["wrong-sdk"] },
        { runtime: { ...manifest.runtime, sha256: "0".repeat(64) } },
      ]) {
        const raw = JSON.stringify({ ...manifest, ...patch });
        sudo("chmod", "u+w", manifestFile);
        sudo("chown", `${process.getuid()}:${process.getgid()}`, manifestFile);
        await writeFile(manifestFile, raw);
        sudo("chown", "root:root", manifestFile);
        await writePolicy([{ ...qualifications[0], manifestSha256: sha(raw) }]);
        await rejected(`${retained}/A`);
      }
      // Restore prior mutations and prove a supported fresh baseline before changing SDK bytes.
      sudo("chown", `${process.getuid()}:${process.getgid()}`, manifestFile);
      await writeFile(manifestFile, originalManifest);
      sudo("chown", "root:root", manifestFile);
      await writePolicy(qualifications);
      const baseline = await observe(launch(`${retained}/A`));
      assert.equal(baseline.supported, true);
      assert.equal(baseline.bindingProbe, true);
      const originalPolicy = await readFile(policy, "utf8");
      const originalHost = manifest.files.find((file) => file.path === "host.cjs");
      assert.ok(originalHost);
      // Change ONLY host bytes, retaining size/mode, manifest and controller authority.
      sudo("chmod", "u+w", `${retained}/A/host.cjs`);
      sudo("cp", `${retained}/B/host.cjs`, `${retained}/A/host.cjs`);
      sudo("chmod", originalHost.mode.toString(8), `${retained}/A/host.cjs`);
      const replaced = await stat(`${retained}/A/host.cjs`);
      assert.equal(replaced.mode & 0o777, originalHost.mode);
      assert.equal(replaced.size, originalHost.size);
      assert.notEqual(sha(await readFile(`${retained}/A/host.cjs`)), originalHost.sha256);
      assert.equal(await readFile(manifestFile, "utf8"), originalManifest);
      assert.equal(await readFile(policy, "utf8"), originalPolicy);
      assert.match(await rejected(`${retained}/A`), /Qualified artifact bytes mismatch/);
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const ended = waitExit(child);
          child.kill("SIGKILL");
          await ended;
        }
      if (previous) await writeFile(policy, previous);
      else await rm(policy, { force: true });
      sudo("rm", "-rf", retained, stage);
    }
  },
);
