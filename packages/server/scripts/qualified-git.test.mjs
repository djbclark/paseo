// Real native protocol/behavior checks, not a protected helper profile or daemon proof.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  open,
  readFile,
  realpath,
  lstat,
  unlink,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { buildQualifiedGit } from "./build-qualified-git.mjs";
import {
  observeFiniteGitConfig,
  assertFiniteGitConfigUnchanged,
} from "../dist/server/server/execution/finite-git-config.js";

if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("Privileged disposable source fixtures run only in Linux GitHub CI");

test(
  "actual Git FD gate preserves NUL/stdin/exit1 and drains naturally on control loss",
  { timeout: 60000 },
  async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "paseo-git-source-"));
    const retained = `/opt/paseo-git-source-${process.pid}`;
    try {
      await buildQualifiedGit(temporary);
      execFileSync("sudo", ["-k", "-n", "/usr/bin/install", "-d", "-m", "0755", retained]);
      for (const file of ["git", "git-observer", "git-gate.so"])
        execFileSync("sudo", [
          "-k",
          "-n",
          "/usr/bin/install",
          "-m",
          "0555",
          path.join(temporary, "runtime", file),
          path.join(retained, file),
        ]);
      execFileSync("/usr/bin/git", ["init", "--quiet", temporary]);
      await writeFile(path.join(temporary, ".worktreeinclude"), "*.txt\n");
      await writeFile(path.join(temporary, ".gitignore"), "*.tmp\n");
      await writeFile(path.join(temporary, "kept.txt"), "copy content\n");
      await writeFile(path.join(temporary, "ignored.tmp"), "ignored\n");
      // Fault-only stand-in is NEVER enrolled or classified as Git. It exercises
      // actual adoption/setsid drainage with a kernel pipe-controlled descendant.
      const faultSource = path.join(temporary, "descendant-fault.c");
      await writeFile(
        faultSource,
        `#include <unistd.h>
#include <stdlib.h>
int main(void) {
  pid_t child=fork(); if(child<0) return 2;
  if(child==0) { pid_t grandchild=fork(); if(grandchild<0) _exit(3);
    if(grandchild==0) { if(setsid()<0) _exit(4); char byte;
      if(read(9,&byte,1)!=1) _exit(5);
      if(write(2,"descendant-complete\\n",20)!=20) _exit(6); _exit(0); }
    _exit(0); }
  return 0;
}`,
      );
      const faultOutput = path.join(temporary, "descendant-fault");
      execFileSync("/usr/bin/cc", [
        "-std=c11",
        "-D_GNU_SOURCE",
        "-O2",
        faultSource,
        "-o",
        faultOutput,
      ]);
      execFileSync("sudo", [
        "-k",
        "-n",
        "/usr/bin/install",
        "-m",
        "0555",
        faultOutput,
        path.join(retained, "descendant-fault"),
      ]);
      const exitSource = path.join(temporary, "exit126.c");
      await writeFile(exitSource, "int main(void) { return 126; }\n");
      const exitOutput = path.join(temporary, "exit126");
      execFileSync("/usr/bin/cc", [exitSource, "-o", exitOutput]);
      execFileSync("sudo", [
        "-k",
        "-n",
        "/usr/bin/install",
        "-m",
        "0555",
        exitOutput,
        path.join(retained, "exit126"),
      ]);
      const invalid = path.join(temporary, "invalid-elf");
      await writeFile(invalid, Buffer.from([127, 69, 76, 70, 0, 0, 0, 0]));
      execFileSync("sudo", [
        "-k",
        "-n",
        "/usr/bin/install",
        "-m",
        "0555",
        invalid,
        path.join(retained, "invalid-elf"),
      ]);
      async function run(operation, stdin = "", behavior = "resume", fault = false) {
        const nonce = randomBytes(32).toString("hex");
        const defaultGitName = fault ? "descendant-fault" : "git";
        const actualGitName = typeof fault === "string" ? fault : defaultGitName;
        const git = await open(path.join(retained, actualGitName)),
          gate = await open(path.join(retained, "git-gate.so"));
        let child;
        try {
          child = spawn(path.join(retained, "git-observer"), [nonce, operation], {
            cwd: temporary,
            env: {
              PATH: "/usr/bin:/bin",
              HOME: temporary,
              LC_ALL: "C",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
            stdio: [
              "pipe",
              "pipe",
              "pipe",
              "pipe",
              "pipe",
              git.fd,
              gate.fd,
              "ignore",
              "ignore",
              "pipe",
            ],
          });
        } finally {
          await git.close();
          await gate.close();
        }
        const streamErrors = [];
        for (const channel of [0, 1, 2, 3, 4, 9])
          child.stdio[channel].on("error", (streamError) => {
            streamErrors.push({ channel, code: streamError.code });
          });
        let output = "",
          error = "",
          wire = "",
          pending = "",
          observed = false;
        child.stdout.on("data", (bytes) => {
          output += bytes.toString();
        });
        child.stderr.on("data", (bytes) => {
          error += bytes.toString();
        });
        const observations = [];
        child.stdio[3].on("data", (bytes) => {
          wire += bytes.toString();
          pending += bytes.toString();
          assert.ok(wire.length < 4096);
          const lines = pending.split("\n");
          pending = lines.pop();
          for (const line of lines) {
            const fields = line.split(" ");
            assert.equal(fields[1], nonce);
            observations.push(line);
            if (fields[0] === "preflight") {
              assert.equal(Number(fields[2]), child.pid);
              if (behavior === "preflight-timeout") {
                /* Carrier alone owns the bounded deadline. */
              } else if (behavior === "preflight-loss") child.stdio[4].end();
              else if (behavior === "preflight-stale")
                child.stdio[4].write(`launch ${"0".repeat(64)}\n`);
              else child.stdio[4].write(`launch ${nonce}\n`);
            }
            if (fields[0] === "leader" && fault === true) {
              assert.ok(!observations.some((row) => row.startsWith("complete ")));
              child.stdio[9].end("x");
            }
            if (fields[0] === "ready") {
              // The constructor still parks this exact actual image while the read runs.
              const identity = Promise.all([
                realpath(`/proc/${fields[2]}/exe`),
                readFile(`/proc/${fields[2]}/stat`, "utf8"),
              ]).then(([image, birth]) => {
                assert.equal(image, path.join(retained, actualGitName));
                assert.equal(birth.slice(0, birth.indexOf(" ")), fields[2]);
                const startToken = birth.slice(birth.lastIndexOf(")") + 2).split(" ")[19];
                assert.match(startToken, /^[1-9][0-9]*$/);
                observed = true;
                if (behavior === "observer-loss") child.kill("SIGKILL");
                else if (behavior === "resume") child.stdio[4].end(`resume ${nonce}\n`);
                else if (behavior === "stale") child.stdio[4].end(`resume ${"0".repeat(64)}\n`);
                else child.stdio[4].end();
                return undefined;
              });
              checks.push(identity);
            }
          }
        });
        const checks = [];
        child.stdin.end(stdin);
        const [code, signal] = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (...args) => resolve(args));
        });
        await Promise.all(checks);
        if (behavior === "observer-loss") {
          assert.ok(
            streamErrors.every(
              (streamError) =>
                [3, 4].includes(streamError.channel) &&
                ["ECONNRESET", "EPIPE"].includes(streamError.code),
            ),
          );
        } else assert.deepEqual(streamErrors, []);
        assert.equal(signal, behavior === "observer-loss" ? "SIGKILL" : null);
        assert.equal(error, fault === true ? "descendant-complete\n" : "");
        assert.equal(observed, !behavior.startsWith("preflight-") && fault !== "invalid-elf");
        const execErrors = observations.filter((row) => row.startsWith("exec-error "));
        if (fault === "invalid-elf") assert.match(execErrors[0], / execveat 8$/);
        else assert.deepEqual(execErrors, []);
        if (behavior === "observer-loss") {
          assert.ok(!observations.some((row) => row.startsWith("complete ")));
        } else {
          assert.ok(
            observations
              .at(-1)
              .endsWith(
                behavior === "resume" && fault !== true && fault !== "invalid-elf"
                  ? " observed"
                  : " unknown",
              ),
          );
        }
        return { code, output };
      }
      assert.deepEqual(await run("ls-files"), { code: 0, output: "kept.txt\0" });
      assert.deepEqual(await run("check-ignore", "ignored.tmp\0kept.txt\0"), {
        code: 0,
        output: "ignored.tmp\0",
      });
      assert.deepEqual(await run("check-ignore", "kept.txt\0"), { code: 1, output: "" });
      assert.deepEqual(await run("ls-files", "", "stale"), { code: 0, output: "kept.txt\0" });
      assert.deepEqual(await run("ls-files", "", "lost"), { code: 0, output: "kept.txt\0" });
      assert.deepEqual(await run("ls-files", "", "preflight-loss"), {
        code: 0,
        output: "kept.txt\0",
      });
      assert.deepEqual(await run("ls-files", "", "preflight-stale"), {
        code: 0,
        output: "kept.txt\0",
      });
      assert.deepEqual(await run("ls-files", "", "preflight-timeout"), {
        code: 0,
        output: "kept.txt\0",
      });
      assert.deepEqual(await run("ls-files", "", "resume", "invalid-elf"), {
        code: 126,
        output: "",
      });
      assert.deepEqual(await run("ls-files", "", "resume", "exit126"), { code: 126, output: "" });
      assert.deepEqual(await run("ls-files", "", "resume", true), { code: 0, output: "" });
      assert.deepEqual(await run("ls-files", "", "observer-loss"), {
        code: null,
        output: "kept.txt\0",
      });
      // These are native source assertions; a recipe/instance grant is deliberately absent.
    } finally {
      execFileSync("sudo", ["-k", "-n", "/usr/bin/rm", "-rf", retained]);
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

test(
  "protected meaningful original Git configuration is observed without minting execution support",
  { timeout: 60000 },
  async () => {
    const stage = await mkdtemp(path.join(tmpdir(), "paseo-config-source-"));
    // Fresh disposable child of already-verified /; runner /opt is world-writable.
    const root = `/paseo-qualified-config-source-${process.pid}`;
    const sudo = (command, args) => execFileSync("sudo", ["-k", "-n", command, ...args]);
    try {
      await mkdir(path.join(stage, "repository"));
      await mkdir(path.join(stage, "config"));
      await mkdir(path.join(stage, "hooks"));
      execFileSync("/usr/bin/git", ["init", "--quiet", path.join(stage, "repository")]);
      await writeFile(
        path.join(stage, "config/system"),
        `[core]\nfsmonitor = false\nhooksPath = ${root}/hooks\n[safe]\ndirectory = ${root}/repository\n`,
      );
      await writeFile(path.join(stage, "config/global"), "[include]\npath = include.conf\n");
      await writeFile(
        path.join(stage, "config/include.conf"),
        `[core]\nexcludesFile = ${root}/config/excludes\n`,
      );
      await writeFile(path.join(stage, "config/excludes"), "external.txt\n");
      await writeFile(path.join(stage, "repository/.worktreeinclude"), "*.txt\n");
      await writeFile(path.join(stage, "repository/.gitignore"), "local.txt\n");
      for (const name of ["external.txt", "local.txt", "keep.txt"])
        await writeFile(path.join(stage, "repository", name), name);
      sudo("/usr/bin/install", ["-d", "-m", "0755", root]);
      sudo("/usr/bin/cp", ["-R", `${stage}/.`, `${root}/`]);
      sudo("/usr/bin/chmod", ["-R", "a-w", root]);
      const environment = {
        HOME: userInfo().homedir,
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_SYSTEM: `${root}/config/system`,
        GIT_CONFIG_GLOBAL: `${root}/config/global`,
      };
      const records = async () =>
        Promise.all(
          [
            "config/system",
            "config/global",
            "config/include.conf",
            "config/excludes",
            "repository/.git/config",
            "repository/.git/HEAD",
          ]
            .sort()
            .map(async (relative) => {
              const bytes = await readFile(path.join(root, relative));
              return {
                path: path.join(root, relative),
                mode: 292,
                size: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              };
            }),
        );
      const recipe = {
        contract: "worktree-include-git-config-v1",
        distributionManifestSha256: "a".repeat(64),
        systemClosureSha256: "b".repeat(64),
        tools: {
          git: "runtime/git",
          observer: "runtime/git-observer",
          gate: "runtime/git-gate.so",
        },
        argv: {
          lsFiles: ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"],
          checkIgnore: ["check-ignore", "--stdin", "-z"],
        },
        repository: {
          cwd: `${root}/repository`,
          gitDirectory: `${root}/repository/.git`,
          layout: "direct-dotgit-v1",
        },
        environment,
        configRoots: {
          system: environment.GIT_CONFIG_SYSTEM,
          global: environment.GIT_CONFIG_GLOBAL,
          local: `${root}/repository/.git/config`,
        },
        includes: [{ from: environment.GIT_CONFIG_GLOBAL, to: `${root}/config/include.conf` }],
        files: await records(),
        protectedAbsent: [
          "commondir",
          "config.worktree",
          "index",
          "objects/info/alternates",
          "shallow",
        ]
          .map((name) => `${root}/repository/.git/${name}`)
          .sort(),
      };
      const proof = await observeFiniteGitConfig(recipe);
      await assertFiniteGitConfigUnchanged(proof);
      await assert.rejects(() =>
        assertFiniteGitConfigUnchanged({ contract: "protected-git-config-v1" }),
      );
      const matches = execFileSync("/usr/bin/git", recipe.argv.lsFiles, {
        cwd: recipe.repository.cwd,
        env: environment,
      });
      const ignored = execFileSync("/usr/bin/git", recipe.argv.checkIgnore, {
        cwd: recipe.repository.cwd,
        env: environment,
        input: matches,
      });
      assert.deepEqual(ignored.toString().split("\0").filter(Boolean).sort(), [
        "external.txt",
        "local.txt",
      ]);
      sudo("/usr/bin/chmod", ["0777", `${root}/config`]);
      await assert.rejects(() => observeFiniteGitConfig(recipe));
      sudo("/usr/bin/chmod", ["0555", `${root}/config`]);
      await observeFiniteGitConfig(recipe); // Restore a real supported component baseline.
      sudo("/usr/bin/chmod", ["0777", `${root}/repository/.git`]);
      await assert.rejects(() => observeFiniteGitConfig(recipe));
      sudo("/usr/bin/chmod", ["0555", `${root}/repository/.git`]);
      await observeFiniteGitConfig(recipe);
      const changed = path.join(stage, "changed");
      await writeFile(changed, '[includeIf "gitdir:*"]\npath = include.conf\n');
      sudo("/usr/bin/install", ["-m", "0444", changed, `${root}/config/global`]);
      await assert.rejects(async () =>
        observeFiniteGitConfig({ ...recipe, files: await records() }),
      );
      await writeFile(changed, "[include]\npath = include.conf\n");
      sudo("/usr/bin/install", ["-m", "0444", changed, `${root}/config/global`]);
      await observeFiniteGitConfig(recipe);
      await writeFile(
        changed,
        `[core]\nfsmonitor = true\nhooksPath = ${root}/hooks\n[safe]\ndirectory = ${root}/repository\n`,
      );
      sudo("/usr/bin/install", ["-m", "0444", changed, `${root}/config/system`]);
      await assert.rejects(async () =>
        observeFiniteGitConfig({ ...recipe, files: await records() }),
      );
      await assert.rejects(() => assertFiniteGitConfigUnchanged(proof));
    } finally {
      sudo("/usr/bin/rm", ["-rf", root]);
      await rm(stage, { recursive: true, force: true });
    }
  },
);

test(
  "asynchronous prelaunch policy CAS refuses a real FIFO in a bounded subprocess",
  { timeout: 10000 },
  async () => {
    const home = await realpath(userInfo().homedir);
    const authority = path.join(
      home,
      ".local/state/djbclark-ade/forks/paseo-qualified-host-policy.json",
    );
    await assert.rejects(() => lstat(authority), { code: "ENOENT" });
    await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 });
    execFileSync("/usr/bin/mkfifo", ["-m", "0600", authority]);
    const original = await lstat(authority);
    try {
      const module = new URL("../dist/server/server/execution/daemon-verifier.js", import.meta.url);
      const program = `import {assertEnclosingAuthorityUnchanged} from ${JSON.stringify(module.href)};
      let refused=false;
      try { await assertEnclosingAuthorityUnchanged({root:"/not-enrolled",authorityIdentity:"not-a-grant"}); }
      catch(error) { if(error.message!=="Enclosing daemon execution unsupported") throw error; refused=true; }
      if(!refused) throw new Error("FIFO was accepted");`;
      execFileSync(process.execPath, ["--input-type=module", "-e", program], {
        timeout: 3000,
        env: { PATH: "/usr/bin:/bin", HOME: "/ignored-ambient-home" },
      });
    } finally {
      const current = await lstat(authority);
      assert.equal(current.ino, original.ino);
      assert.equal(current.dev, original.dev);
      await unlink(authority);
    }
  },
);

test("original protected PATH Git is byte-equivalent and its private descriptor proof cannot be forged", async () => {
  const { observeOriginalGitSelection, assertOriginalGitSelection, closeOriginalGitSelection } =
    await import("../dist/server/server/execution/finite-git-selection.js");
  const image = await readFile("/usr/bin/git");
  const expected = {
    path: "runtime/git",
    mode: 0o555,
    size: image.length,
    sha256: createHash("sha256").update(image).digest("hex"),
  };
  const proof = await observeOriginalGitSelection(expected);
  await assertOriginalGitSelection(proof);
  await assert.rejects(() => assertOriginalGitSelection({ path: "/usr/bin/git" }));
  await closeOriginalGitSelection(proof);
  await assert.rejects(() => assertOriginalGitSelection(proof));
  await assert.rejects(() => observeOriginalGitSelection({ ...expected, sha256: "0".repeat(64) }));
});
