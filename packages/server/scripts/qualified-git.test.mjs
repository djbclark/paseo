// Real native protocol/behavior checks, not a protected helper profile or daemon proof.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, open, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { buildQualifiedGit } from "./build-qualified-git.mjs";

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
      async function run(operation, stdin = "", behavior = "resume", fault = false) {
        const nonce = randomBytes(32).toString("hex");
        const git = await open(path.join(retained, fault ? "descendant-fault" : "git")),
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
            if (fields[0] === "leader" && fault) {
              assert.ok(!observations.some((row) => row.startsWith("complete ")));
              child.stdio[9].end("drain");
            }
            if (fields[0] === "ready") {
              // The constructor still parks this exact actual image while the read runs.
              const identity = Promise.all([
                realpath(`/proc/${fields[2]}/exe`),
                readFile(`/proc/${fields[2]}/stat`, "utf8"),
              ]).then(([image, birth]) => {
                assert.equal(image, path.join(retained, fault ? "descendant-fault" : "git"));
                assert.equal(birth.slice(0, birth.indexOf(" ")), fields[2]);
                const startToken = birth.slice(birth.lastIndexOf(")") + 2).split(" ")[19];
                assert.match(startToken, /^[1-9][0-9]*$/);
                observed = true;
                if (behavior === "resume") child.stdio[4].end(`resume ${nonce}\n`);
                else if (behavior === "stale") child.stdio[4].end(`resume ${"0".repeat(64)}\n`);
                else child.stdio[4].end();
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
        assert.equal(signal, null);
        assert.equal(error, fault ? "descendant-complete\n" : "");
        assert.equal(observed, true);
        assert.ok(
          observations.at(-1).endsWith(behavior === "resume" && !fault ? " observed" : " unknown"),
        );
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
      assert.deepEqual(await run("ls-files", "", "resume", true), { code: 0, output: "" });
      // These are native source assertions; a recipe/instance grant is deliberately absent.
    } finally {
      execFileSync("sudo", ["-k", "-n", "/usr/bin/rm", "-rf", retained]);
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
