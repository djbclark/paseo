// Fixed read-only CI parent. Only the separately inventoried component fixture
// is launched; none of these observations qualify the production service.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { promisify } from "node:util";

export async function runOwnerComposition(settings) {
  const { root, policyPath, enrollment, paseoHome, source } = settings;
  const { createQualifiedDaemonInvocation } = await import(`${root}/daemon-launcher.mjs`);
  async function enroll() {
    await writeFile(
      policyPath,
      JSON.stringify({ schemaVersion: 1, qualifications: [enrollment] }),
      { mode: 0o600 },
    );
    await chmod(policyPath, 0o600);
  }
  async function reference(environment) {
    const exec = promisify(execFile);
    const { stdout } = await exec(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"],
      { cwd: source, env: environment },
    );
    const check = exec("git", ["check-ignore", "--stdin", "-z"], { cwd: source, env: environment });
    check.child.stdin.end(stdout);
    const ignored = (await check).stdout.split("\0").filter(Boolean).sort();
    assert.deepEqual(ignored, ["external.txt", "local.txt"]);
  }
  async function runCase(phase, revoke) {
    // A restored supported baseline is checked before EVERY independent race.
    await enroll();
    const invocation = await createQualifiedDaemonInvocation(root, paseoHome);
    assert.deepEqual(invocation.env, enrollment.builtinProfiles[0].finiteGit.recipe.environment);
    await reference(invocation.env);
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let diagnostics = "",
      overflow = false,
      result,
      failure;
    const capture = (bytes) => {
      if (Buffer.byteLength(diagnostics) + bytes.length > 65536) overflow = true;
      else diagnostics += bytes;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      failure = error;
    });
    let events = Promise.resolve();
    child.on("message", (message) => {
      events = events
        .then(async () => {
          if (message?.type === "fixture.awaiting-case")
            child.send({ type: "fixture.case", phase, revoke });
          else if (message?.type === "fixture.revoke") {
            assert.equal(revoke, true);
            await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, qualifications: [] }));
            child.send({ type: "fixture.revoked" });
          } else if (message?.type === "fixture.result") {
            assert.equal(result, undefined);
            result = message;
          } else throw new Error("Unexpected fixed fixture observation");
          return undefined;
        })
        .catch((error) => {
          failure = error;
          return undefined;
        });
    });
    const terminal = await new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    await events;
    if (failure) throw failure;
    assert.equal(overflow, false, "Component diagnostic overflow");
    assert.deepEqual(terminal, { code: 0, signal: null }, diagnostics);
    assert.deepEqual(result, {
      type: "fixture.result",
      phase,
      revoke,
      state: revoke ? "unknown" : "held",
      qualification: false,
    });
  }
  for (const phase of ["preflight", "ready", "settlement"]) {
    await runCase(phase, false);
    await runCase(phase, true);
  }
  await enroll();
  assert.ok(await readFile(policyPath));
  console.log(
    JSON.stringify({ component: "actual-owner-sdk-worktree-hook", cases: 6, qualification: false }),
  );
}
