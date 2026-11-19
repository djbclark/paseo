import { AsyncLocalStorage } from "node:async_hooks";
import { execQualifiedBuiltinFile } from "./builtin-helper.js";
import { execFile as nativeExecFile, spawn } from "node:child_process";
import { collectBuiltinExecFile } from "./builtin-exec-collector.js";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PluginActivityOwner, bindPluginActivity, acquirePluginHelper } from "./activity.js";
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
  // Preserve JS escapes for the child parser; argv itself must contain no NUL.
  const script = String.raw`
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

it("preserves the original command after postlaunch observation failure while holding unknown", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import {PluginActivityOwner,installQualifiedHelperAdmission} from '@getpaseo/plugin/internal/activity';
    import {execCommand} from '@getpaseo/plugin/server';
    const owner=new PluginActivityOwner();
    let bound=0;
    installQualifiedHelperAdmission(()=>({
      settled:new Promise(()=>{}),
      bind(child){assert.ok(child.pid>0);bound++;throw new Error('postlaunch observation lost')},
      failed(){},
    }));
    const root=owner.acquire();
    const result=await root.run(()=>execCommand(process.execPath,['-e','process.stdout.write("original-command-finished")']));
    root.release();
    assert.equal(result.stdout,'original-command-finished');
    assert.equal(bound,1);
    assert.equal(owner.begin({generation:1,transactionId:'failed-proof',instanceId:'actual'}),'unknown');
    process.stdout.write('original-finished-still-unknown');
  `;
  const { stdout } = await promisify(nativeExecFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: new URL("../../../", import.meta.url),
      env: { PATH: process.env.PATH },
    },
  );
  expect(stdout).toBe("original-finished-still-unknown");
});

it("distinguishes definite inner exec errno from actual carrier exit 126 at close", async () => {
  for (const errno of [null, 2, 11]) {
    let closed = false;
    let reads = 0;
    let callbacks = 0;
    const result = await new Promise<Error | null>((resolve) => {
      collectBuiltinExecFile(
        {
          start() {
            const carrier = spawn(process.execPath, ["-e", "process.exit(126)"], { stdio: "pipe" });
            carrier.once("close", () => {
              closed = true;
            });
            return carrier;
          },
          readExecFailure() {
            expect(closed).toBe(true);
            reads++;
            return errno === null ? null : { errno, syscall: errno === 11 ? "fork" : "execveat" };
          },
        },
        { kind: "execFile", command: "git", args: ["query"], options: {} },
        (error) => {
          callbacks++;
          resolve(error);
        },
      );
    });
    expect(reads).toBe(1);
    expect(callbacks).toBe(1);
    expect(result).toMatchObject(
      errno === null
        ? { code: 126 }
        : {
            code: errno === 11 ? "EAGAIN" : "ENOENT",
            errno: -errno,
            syscall: "spawn git",
            path: "git",
            spawnargs: ["query"],
          },
    );
  }
});

it("keeps actual carrier spawn errors distinct and invokes its callback once", async () => {
  let reads = 0;
  let callbacks = 0;
  const result = await new Promise<Error | null>((resolve) => {
    collectBuiltinExecFile(
      {
        start: () => spawn("/paseo-nonexistent-carrier/exec", [], { stdio: "pipe" }),
        readExecFailure() {
          reads++;
          return { errno: 13, syscall: "execvp" };
        },
      },
      { kind: "execFile", command: "git", args: [], options: {} },
      (error) => {
        callbacks++;
        resolve(error);
      },
    );
  });
  expect(result).toMatchObject({ code: "ENOENT", path: "/paseo-nonexistent-carrier/exec" });
  expect(reads).toBe(0);
  expect(callbacks).toBe(1);
});

it("rejects ADE semantic authority/argv fields and enforces UTF-8 request bounds", async () => {
  const { parseAdeDirectoryRequest } = await import("../ade-directory-schema.js");
  const input = {
    version: 1,
    operation: "claim-new",
    cwd: "/worktree",
    branch: "main",
    claimId: "claim",
    ttlHours: 1,
    ownerAgent: "",
    ownerRecord: null,
  };
  expect(parseAdeDirectoryRequest(input)).toEqual(input);
  expect(() => parseAdeDirectoryRequest({ ...input, argv: ["python"] })).toThrow();
  expect(() => parseAdeDirectoryRequest({ ...input, cwd: "/worktree/../other" })).toThrow();
  expect(() => parseAdeDirectoryRequest({ ...input, branch: "😀".repeat(300) })).toThrow();
  expect(() => parseAdeDirectoryRequest({ ...input, branch: "\uD800" })).toThrow();
  expect(() => parseAdeDirectoryRequest({ ...input, ttlHours: Infinity })).toThrow();
});
it("keeps exact ADE business outcomes distinct from process failure and repeated keys", async () => {
  const { parseAdeDirectoryRequest, parseAdeDirectoryResult } =
    await import("../ade-directory-schema.js");
  const request = parseAdeDirectoryRequest({
    version: 1,
    operation: "claim-install-hooks",
    cwd: "/worktree",
  });
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  expect(
    parseAdeDirectoryResult(
      request,
      bytes({ version: 1, status: 78, output: { notes: ["hooksPath refused"] } }),
      78,
    ),
  ).toMatchObject({ status: 78 });
  expect(
    parseAdeDirectoryResult(
      request,
      bytes({
        version: 1,
        status: 2,
        output: { kind: "invalid-request", diagnostic: "Invalid directory operation input." },
      }),
      2,
    ),
  ).toMatchObject({ status: 2 });
  expect(() =>
    parseAdeDirectoryResult(request, bytes({ version: 1, status: 0, output: { notes: [] } }), 1),
  ).toThrow("exit/status");
  expect(() =>
    parseAdeDirectoryResult(
      request,
      Buffer.from('{"version":1,"status":0,"status":78,"output":{"notes":[]}}'),
      78,
    ),
  ).toThrow("Duplicate");
  expect(() =>
    parseAdeDirectoryResult(
      request,
      Buffer.from('{"version":1,"status":0,"output":{"notes":[],"n\\u006ftes":[]}}'),
      0,
    ),
  ).toThrow("Duplicate");
  expect(() =>
    parseAdeDirectoryResult(request, bytes({ version: 1, status: 1, output: { notes: [] } }), 1),
  ).toThrow();
});
it("preserves hooks-path NUL facts while refusing NUL for other ADE facts and unknown records", async () => {
  const { parseAdeDirectoryRequest, parseAdeDirectoryResult } =
    await import("../ade-directory-schema.js");
  const request = parseAdeDirectoryRequest({
    version: 1,
    operation: "repository-facts",
    selection: "hooks-path",
    cwd: "/worktree",
  });
  const bytes = Buffer.from(
    JSON.stringify({ version: 1, selection: "hooks-path", status: 0, stdout: "one\0two\0" }),
  );
  expect(parseAdeDirectoryResult(request, bytes, 0)).toMatchObject({ stdout: "one\0two\0" });
  const head = parseAdeDirectoryRequest({
    version: 1,
    operation: "repository-facts",
    selection: "head",
    cwd: "/worktree",
  });
  expect(() => parseAdeDirectoryResult(head, bytes, 0)).toThrow();
  const list = parseAdeDirectoryRequest({ version: 1, operation: "claim-list", cwd: "/worktree" });
  expect(() =>
    parseAdeDirectoryResult(list, Buffer.from('{"version":1,"status":0,"output":[{"v":2}]}'), 0),
  ).toThrow();
});

it("captures immutable original hook DATA without reviving expired or initialization roots", async () => {
  const { capturePluginActivityOrigin, acquireAdeDirectoryActivity } =
    await import("./activity.js");
  const owner = new PluginActivityOwner();
  const message = { type: "hook", name: "worktree.create.after", input: { cwd: "/original" } };
  const origin = capturePluginActivityOrigin("actual-request", message);
  message.input.cwd = "/candidate-forgery";
  expect(origin.message).toMatchObject({ input: { cwd: "/original" } });
  expect(Object.isFrozen(origin.message)).toBe(true);
  expect(() => acquireAdeDirectoryActivity()).toThrow("Missing original");
  const root = owner.acquire(() => {}, origin);
  const helper = root.run(() => acquireAdeDirectoryActivity());
  expect(helper.originalEvent).toBe(origin);
  root.release();
  expect(owner.begin(identity)).toBe("known-busy");
  helper.release();
  expect(owner.state()).toBe("held");
  expect(() => root.run(() => acquireAdeDirectoryActivity())).toThrow("Expired");
  const initialization = owner.initialization();
  expect(() => initialization.run(() => acquireAdeDirectoryActivity())).toThrow("Missing original");
  initialization.release();
});

it("refuses missing directory producer and retains unknown preparation independently of result rejection", async () => {
  const { runAdeDirectoryOperation } = await import("../ade-helpers.js");
  const { installQualifiedAdeDirectoryAdapter } = await import("./ade-directory.js");
  const { capturePluginActivityOrigin } = await import("./activity.js");
  const request = { version: 1 as const, operation: "claim-list" as const, cwd: "/worktree" };
  await expect(runAdeDirectoryOperation(request)).rejects.toThrow("producer unavailable");
  const owner = new PluginActivityOwner();
  const root = owner.acquire(
    () => {},
    capturePluginActivityOrigin("actual-request", {
      type: "hook",
      name: "workspace.archive.after",
      input: { cwd: "/worktree" },
    }),
  );
  let preparing = false;
  installQualifiedAdeDirectoryAdapter({
    acquire(snapshot, context) {
      expect(preparing).toBe(false);
      expect(snapshot).toEqual(request);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(context.activityOwner).toBe(owner);
      owner.assertLiveRoot(context.root);
      return {
        // Adapter-negative unit only: unresolved proof must NEVER certify helpers settled.
        settled: new Promise(() => {}),
        async prepare() {
          preparing = true;
          throw new Error("fact preparation proof lost");
        },
      };
    },
  });
  expect(() =>
    installQualifiedAdeDirectoryAdapter({
      acquire() {
        throw new Error("replacement");
      },
    }),
  ).toThrow("already installed");
  await expect(root.run(() => runAdeDirectoryOperation(request))).rejects.toThrow("proof lost");
  root.release();
  expect(owner.begin(identity)).toBe("unknown");
  await expect(owner.waitForRetirement()).rejects.toThrow("uncertain");
});

it("delivers original validated directory stdin once after postlaunch bind failure without certifying settlement", async () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import {spawn} from 'node:child_process';
    import {mkdtemp,readFile,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';
    import path from 'node:path';
    import {PluginActivityOwner,capturePluginActivityOrigin} from '@getpaseo/plugin/internal/activity';
    import {installQualifiedAdeDirectoryAdapter} from '@getpaseo/plugin/internal/ade-directory';
    import {runAdeDirectoryOperation} from '@getpaseo/plugin/server/ade-helpers';
    const home=await mkdtemp(path.join(tmpdir(),'ade-directory-bind-unit-'));
    const marker=path.join(home,'actual-operation');
    const owner=new PluginActivityOwner();
    const request={version:1,operation:'claim-release',cwd:home,claimId:'claim'};
    const root=owner.acquire(()=>{},capturePluginActivityOrigin('actual-hook',{type:'hook',name:'workspace.archive.after',input:{cwd:home}}));
    let starts=0;
    installQualifiedAdeDirectoryAdapter({acquire(){return {
      // Negative SDK output/lifetime unit only; actual descendant proof remains absent.
      settled:new Promise(()=>{}),
      async prepare(){return {kind:'python',stdin:Buffer.from(JSON.stringify({version:1,request,facts:{}})),
        start(){starts++;return spawn(process.execPath,['-e',"const fs=require('node:fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.appendFileSync(process.argv[1],'ran-once');JSON.parse(input);process.stdout.write(JSON.stringify({version:1,status:0,output:{claimId:'claim'}}))})",marker],{stdio:'pipe'});},
        bind(){throw new Error('postlaunch proof lost')},failed(){},
      }}
    }}});
    try {
      await assert.rejects(root.run(()=>runAdeDirectoryOperation(request)),/execution failed/);
      root.release();
      assert.equal(starts,1);
      assert.equal(await readFile(marker,'utf8'),'ran-once');
      assert.equal(owner.begin({generation:1,transactionId:'unit',instanceId:'actual'}),'unknown');
      process.stdout.write('original-once-proof-unknown');
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
  expect(stdout).toBe("original-once-proof-unknown");
});

it("distinguishes expired roots from wrong owners and never revives them for local settings reads", async () => {
  const owner = new PluginActivityOwner();
  const other = new PluginActivityOwner();
  const root = owner.acquire();
  let expiredRead!: () => ReturnType<PluginActivityOwner["retainCurrentIfLive"]>;
  const settled = root.run(() => owner.waitForCurrentSettlement());
  root.run(() => {
    expiredRead = bindPluginActivity(() => owner.retainCurrentIfLive());
    expect(() => other.retainCurrentIfLive()).toThrow("owner mismatch");
  });
  root.release();
  await settled;
  expect(expiredRead()).toBeUndefined();
  expect(owner.state()).toBe("held");
  expect(owner.retainCurrentIfLive()).toBeUndefined();
  owner.markUnknown();
  expect(expiredRead).toThrow("uncertain");
});

it("waits for the exact initialization root, preserves its no-helper restriction and rejects uncertainty", async () => {
  const owner = new PluginActivityOwner();
  owner.qualifyPassive();
  const root = owner.initialization();
  const drain = root.run(() => owner.waitForCurrentSettlement());
  const operation = root.run(() => owner.retainCurrent());
  let drained = false;
  void drain.then(
    () => {
      drained = true;
      return undefined;
    },
    () => {},
  );
  root.release();
  await Promise.resolve();
  expect(drained).toBe(false);
  operation.run(() => {
    expect(() =>
      acquirePluginHelper({ kind: "execFile", command: "denied", args: [], options: {} }),
    ).toThrow();
  });
  owner.markUnknown();
  await expect(drain).rejects.toThrow("uncertain");
  // Actual already-admitted work can drain, but a late settlement never resets UNKNOWN.
  const continuation = operation.run(() => owner.retainCurrent());
  continuation.release();
  operation.release();
  expect(owner.state()).toBe("unknown");
});
