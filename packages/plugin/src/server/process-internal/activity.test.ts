import { AsyncLocalStorage } from "node:async_hooks";
import { execQualifiedBuiltinFile } from "./builtin-helper.js";
import { execFile as nativeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PluginActivityOwner } from "./activity.js";
import { spawnProcess, execCommand } from "../process.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const identity = { generation: 1, transactionId: "transaction", instanceId: "instance" };
async function signal(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}
it("retains the same actual root through a helper outliving the handler and never cancels it for begin", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "plugin-helper-lifetime-"));
  roots.push(home);
  const release = path.join(home, "release");
  const begun = path.join(home, "begun");
  const owner = new PluginActivityOwner();
  owner.qualifyPassive();
  let settled = false;
  const root = owner.acquire(() => {
    settled = true;
  });
  const script = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(begun)}, 'started'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10);`;
  const child = root.run(() => spawnProcess(process.execPath, ["-e", script], { stdio: "pipe" }));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  root.release();
  try {
    await expect.poll(() => signal(begun)).toBe("started");
    expect(settled).toBe(false);
    expect(owner.begin(identity)).toBe("known-busy");
    expect(child.exitCode).toBeNull();
    owner.end(identity);
    await writeFile(release, "go");
    await closed;
    expect(settled).toBe(true);
    expect(owner.begin(identity)).toBe("held");
    expect(() => owner.end({ ...identity, transactionId: "wrong" })).toThrow("mismatch");
    expect(() =>
      root.run(() => spawnProcess(process.execPath, ["-e", "process.exit(99)"])),
    ).toThrow("Settled plugin activity");
    owner.end(identity);
  } finally {
    await writeFile(release, "go");
    await closed;
  }
});
it("caller abort cannot settle actual helper activity before child close", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "plugin-helper-abort-"));
  roots.push(home);
  const release = path.join(home, "release");
  const begun = path.join(home, "begun");
  const owner = new PluginActivityOwner();
  owner.qualifyPassive();
  let settled = false;
  const root = owner.acquire(() => {
    settled = true;
  });
  const controller = new AbortController();
  const script = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(begun)},'started'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10);`;
  const operation = root.run(() =>
    execCommand(process.execPath, ["-e", script], { signal: controller.signal }),
  );
  const rejected = expect(operation).rejects.toThrow();
  root.release();
  try {
    await expect.poll(() => signal(begun)).toBe("started");
    controller.abort();
    await rejected;
    expect(settled).toBe(false);
    expect(owner.begin(identity)).toBe("known-busy");
    owner.end(identity);
    await writeFile(release, "go");
    await expect.poll(() => settled).toBe(true);
    expect(owner.begin(identity)).toBe("held");
    owner.end(identity);
  } finally {
    await writeFile(release, "go");
    await operation.catch(() => undefined);
    await expect.poll(() => settled, { timeout: 5000 }).toBe(true);
  }
});

it("sealed startup helper restriction applies before ALS and cannot be replaced", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { installQualifiedHelperAdmission } from '@getpaseo/plugin/internal/activity';
    import { spawnProcess, execCommand } from '@getpaseo/plugin/server';
    let calls = 0;
    installQualifiedHelperAdmission(() => { calls++; throw new Error('qualified zero-helper'); });
    assert.throws(() => installQualifiedHelperAdmission(() => {}), /already installed/);
    assert.throws(() => spawnProcess(process.execPath, ['-e', 'process.exit(99)']), /qualified zero-helper/);
    await assert.rejects(execCommand(process.execPath, ['-e', 'process.exit(99)']), /qualified zero-helper/);
    assert.equal(calls, 2);
    process.stdout.write('helper-guard-verified');
  `;
  const { stdout } = await promisify(nativeExecFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: new URL("../../../", import.meta.url),
      env: { PATH: process.env.PATH },
    },
  );
  expect(stdout).toBe("helper-guard-verified");
});

it("preserves builtin execFile callbacks, promisify output and the actual child handle", async () => {
  const owner = new PluginActivityOwner();
  owner.qualifyPassive();
  const callbackRoot = owner.acquire();
  let callbackChild: import("node:child_process").ChildProcess | undefined;
  const callbackResult = new Promise<string>((resolve, reject) => {
    callbackChild = callbackRoot.run(() =>
      execQualifiedBuiltinFile(
        process.execPath,
        ["-e", "process.stdout.write('callback')"],
        (error, stdout) => {
          if (error) reject(error);
          else resolve(String(stdout));
        },
      ),
    );
  });
  const callbackClosed = new Promise<void>((resolve) =>
    callbackChild!.once("close", () => resolve()),
  );
  callbackRoot.release();
  expect(callbackChild?.pid).toBeGreaterThan(0);
  expect(await callbackResult).toBe("callback");
  await callbackClosed;
  const promisedRoot = owner.acquire();
  const operation = promisedRoot.run(() =>
    promisify(execQualifiedBuiltinFile)(process.execPath, [
      "-e",
      "process.stdout.write('promise');process.stderr.write('diagnostic')",
    ]),
  );
  const actualChild = Reflect.get(operation, "child") as import("node:child_process").ChildProcess;
  const actualClosed = new Promise<void>((resolve) => actualChild.once("close", () => resolve()));
  promisedRoot.release();
  expect(actualChild.pid).toBeGreaterThan(0);
  await expect(operation).resolves.toMatchObject({ stdout: "promise", stderr: "diagnostic" });
  await actualClosed;
  expect(owner.begin(identity)).toBe("held");
  owner.end(identity);
});

it("keeps a real helper root busy after leader close until the producer settlement is proved", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import {once} from 'node:events';
    import {PluginActivityOwner,installQualifiedHelperAdmission} from '@getpaseo/plugin/internal/activity';
    import {spawnProcess} from '@getpaseo/plugin/server';
    const owner = new PluginActivityOwner();
    owner.qualifyPassive();
    let bound;
    let requestRoot;
    installQualifiedHelperAdmission((request) => {
      assert.equal(request.activityOwner,owner);
      owner.assertLiveRoot(request.root);
      requestRoot = request.root;
      assert.equal(request.operation.kind,'spawn');
      return {settled:new Promise(() => {}),bind(child) { assert.ok(child.pid > 0); bound=child; },failed(error) { throw error; }};
    });
    const root = owner.acquire();
    const child = root.run(() => spawnProcess(process.execPath,['-e','process.stdout.write("done")'],{stdio:'pipe'}));
    assert.equal(bound,child);
    root.release();
    await once(child,'close');
    owner.assertLiveRoot(requestRoot);
    assert.throws(() => owner.assertLiveRoot({}),/Unknown/);
    assert.equal(owner.begin({generation:1,transactionId:'pending',instanceId:'actual'}),'known-busy');
    process.stdout.write('actual-close-is-not-descendant-settlement');
  `;
  const { stdout } = await promisify(nativeExecFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: new URL("../../../", import.meta.url), env: { PATH: process.env.PATH } },
  );
  expect(stdout).toBe("actual-close-is-not-descendant-settlement");
});

it("restores the original admitted context and permits its necessary late helper after begin", async () => {
  const nativeContext = new AsyncLocalStorage<string>();
  const owner = new PluginActivityOwner();
  owner.qualifyPassive();
  const root = nativeContext.run("original-live-root", () => owner.acquire());
  expect(owner.begin(identity)).toBe("known-busy");
  expect(() => owner.acquire()).toThrow("admission is closed");
  const operation = nativeContext.run("different-caller", () =>
    root.run(() => {
      expect(nativeContext.getStore()).toBe("original-live-root");
      return execCommand(process.execPath, ["-e", "process.stdout.write('late helper')"]);
    }),
  );
  root.release();
  await expect(operation).resolves.toEqual({ stdout: "late helper", stderr: "" });
  await expect.poll(() => owner.state()).toBe("held");
  owner.end(identity);
});

it("retirement closes new roots and waits for actual admitted helper closure", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "plugin-retirement-"));
  roots.push(home);
  const release = path.join(home, "release");
  const begun = path.join(home, "begun");
  const owner = new PluginActivityOwner();
  const root = owner.acquire();
  const child = root.run(() =>
    spawnProcess(
      process.execPath,
      [
        "-e",
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(begun)},'yes');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10)`,
      ],
      { stdio: "pipe" },
    ),
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  await expect.poll(() => signal(begun)).toBe("yes");
  const cleanup = owner.retirementCleanup();
  cleanup.release();
  root.release();
  let drained = false;
  const retirement = owner.waitForRetirement().then(() => {
    drained = true;
    return undefined;
  });
  expect(() => owner.acquire()).toThrow("admission is closed");
  expect(drained).toBe(false);
  expect(owner.state()).toBe("known-busy");
  try {
    await writeFile(release, "finish");
    await closed;
    await retirement;
    expect(drained).toBe(true);
  } finally {
    await writeFile(release, "finish");
    await closed;
  }
});
it("uncertain cleanup never becomes a successful retirement", async () => {
  const owner = new PluginActivityOwner();
  const cleanup = owner.retirementCleanup();
  const retirement = owner.waitForRetirement();
  owner.markUnknown();
  cleanup.release();
  await expect(retirement).rejects.toThrow("uncertain");
  await expect(owner.waitForRetirement()).rejects.toThrow("uncertain");
});

it("preserves actual Git execFile stdin, NUL output and exit-1 errors through a once-only private launch", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import {execFileSync,spawn} from 'node:child_process';
    import {mkdtemp,writeFile,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';
    import path from 'node:path';
    import {promisify} from 'node:util';
    import {PluginActivityOwner,installQualifiedHelperAdmission} from '@getpaseo/plugin/internal/activity';
    import {execQualifiedBuiltinFile} from '@getpaseo/plugin/internal/builtin-helper';
    const home=await mkdtemp(path.join(tmpdir(),'sdk-git-exec-'));
    const owner=new PluginActivityOwner();
    const root=owner.acquire();
    let launches=0;
    installQualifiedHelperAdmission(request => {
      assert.equal(request.activityOwner,owner);
      owner.assertLiveRoot(request.root);
      let actual;
      return {
        // This is an output-adapter unit, not a qualified producer/descendant proof.
        // No actual helper is declared settled from leader close.
        settled:new Promise(()=>{}),
        builtinExecFile:{start(){
          assert.equal(actual,undefined);
          launches++;
          actual=spawn(request.operation.command,[...request.operation.args],{cwd:request.operation.options.cwd,stdio:'pipe'});
          return actual;
        }},
        bind(child){assert.equal(child,actual)},failed(error){throw error},
      };
    });
    try {
      execFileSync('git',['init','-q',home]);
      await writeFile(path.join(home,'.gitignore'),'*.local\n');
      await writeFile(path.join(home,'.worktreeinclude'),'*.local\n');
      await writeFile(path.join(home,'retained.local'),'content');
      const exec=promisify(execQualifiedBuiltinFile);
      const listed=await root.run(()=>exec('git',['ls-files','--others','--ignored','--exclude-from=.worktreeinclude','-z'],{cwd:home,maxBuffer:64*1024*1024}));
      assert.equal(listed.stdout,'retained.local\0');
      const checked=root.run(()=>exec('git',['check-ignore','--stdin','-z'],{cwd:home,maxBuffer:64*1024*1024}));
      assert.ok(checked.child.stdin);
      checked.child.stdin.end('not-ignored\0');
      await assert.rejects(checked,error=>error.code===1 && error.stdout==='' && error.stderr==='');
      await root.run(()=>new Promise((resolve,reject)=>{
        const child=execQualifiedBuiltinFile('git',['check-ignore','--stdin','-z'],{cwd:home,maxBuffer:64*1024*1024},(error,stdout,stderr)=>{
          try {assert.equal(error,null);assert.equal(stdout,'retained.local\0');assert.equal(stderr,'');resolve()}catch(error){reject(error)}
        });
        child.stdin.end('retained.local\0');
      }));
      assert.equal(launches,3);
      root.release();
      assert.equal(owner.begin({generation:1,transactionId:'no-proof',instanceId:'actual'}),'known-busy');
      process.stdout.write('actual-git-output-without-qualification');
    } finally {await rm(home,{recursive:true,force:true})}
  `;
  const { stdout } = await promisify(nativeExecFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: new URL("../../../", import.meta.url),
      env: { PATH: process.env.PATH },
    },
  );
  expect(stdout).toBe("actual-git-output-without-qualification");
});
