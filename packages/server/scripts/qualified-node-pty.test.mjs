import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { before, test } from "node:test";
import { promisify } from "node:util";
import {
  buildQualifiedNodePtyCopy,
  NODE_PTY_INPUTS,
  validateNodePtyBuildRecord,
} from "./build-qualified-node-pty.mjs";

const execute = promisify(execFile);
const hash = (data) => createHash("sha256").update(data).digest("hex");
let prepared;
let root;
let result;
let record;
async function copyRoot() {
  const directory = await mkdtemp(path.join(path.dirname(prepared.root), "copy-"));
  await mkdir(path.join(directory, "runtime"));
  await cp(path.join(prepared.root, "runtime/node"), path.join(directory, "runtime/node"));
  await cp(path.join(prepared.root, "node_modules"), path.join(directory, "node_modules"), {
    recursive: true,
  });
  return directory;
}
function options(directory) {
  return { ...prepared.options, runtime: path.join(directory, "runtime/node") };
}
before(async () => {
  assert.ok(
    process.env.QUALIFIED_NODE_PTY_INPUTS,
    "CI must provide checksum-verified prepared inputs",
  );
  prepared = JSON.parse(await readFile(process.env.QUALIFIED_NODE_PTY_INPUTS, "utf8"));
  root = await copyRoot();
  result = await buildQualifiedNodePtyCopy(root, options(root));
  record = JSON.parse(await readFile(path.join(root, result.record.path), "utf8"));
});

test("builds the selected source offline and reports the actual new artifact", async () => {
  assert.deepEqual(Object.keys(result).sort(), ["addon", "record"]);
  assert.equal(hash(await readFile(path.join(root, result.addon.path))), result.addon.sha256);
  assert.equal(hash(await readFile(path.join(root, result.record.path))), result.record.sha256);
  assert.equal((await stat(path.join(root, result.addon.path))).mode & 0o777, 0o555);
  assert.equal(record.outputs.original.sha256, NODE_PTY_INPUTS.original);
  assert.equal(record.outputs.addon.sha256, result.addon.sha256);
  assert.equal(record.qualification, false);
  assert.deepEqual(validateNodePtyBuildRecord(record), record);
  assert.equal(record.commands.filter((row) => row.role === "compile").length, 1);
  assert.equal(record.commands.filter((row) => row.role === "link").length, 1);
  const compile = record.commands.find((row) => row.role === "compile");
  assert.ok(compile.argv.includes("-MD"));
  assert.ok(compile.argv.includes("-save-temps=obj"));
  assert.ok(compile.argv.includes("-DNAPI_CPP_EXCEPTIONS"));
  assert.ok(record.dependencies.headers.some((row) => row.path.endsWith("/napi.h")));
  assert.ok(record.dependencies.headers.some((row) => row.path.startsWith("/usr/include/")));
  assert.ok(record.dependencies.linkInputs.length > 0);
  assert.notEqual(record.outputs.preprocessed, null);
  assert.equal(record.coverage.syscallTrace, false);
  assert.equal(record.coverage.hermetic, false);
  assert.equal(record.coverage.reproducibleOldPrebuild, false);
  assert.equal(record.inputs.node.runtime.sha256, NODE_PTY_INPUTS.runtime);
  const environmentFile = record.evidence.find((file) =>
    file.path.endsWith("build-environment.json"),
  );
  const environment = JSON.parse(await readFile(path.join(root, environmentFile.path), "utf8"));
  assert.equal(environment.PATH, `${path.join(root, "runtime")}:/usr/bin:/bin`);
  assert.equal(environment.SYSROOT_PATH, "");
  assert.equal(environment.PYTHON, "/usr/bin/python3");
  assert.equal(environment.NODE_OPTIONS, undefined);
});

test("GYP selected Node is proved before configure despite absent or different system candidates", async () => {
  const bindingFile = record.evidence.find((file) => file.path.endsWith("node-binding.json"));
  const binding = JSON.parse(await readFile(path.join(root, bindingFile.path), "utf8"));
  const runtime = path.join(root, "runtime/node");
  assert.deepEqual(binding, { executable: runtime, version: "v22.23.5" });
  const bindingIndex = record.commands.findIndex((row) => row.role === "node-binding");
  const configureIndex = record.commands.findIndex((row) => row.role === "configure");
  assert.ok(bindingIndex >= 0 && bindingIndex < configureIndex);
  const empty = await mkdtemp(path.join(prepared.options.stagingRoot, "empty-node-path-"));
  const different = await mkdtemp(path.join(prepared.options.stagingRoot, "other-node-path-"));
  const otherNodeScript = "#!/bin/sh\nprintf '%s\\n' 'different-system-node'\n";
  await writeFile(path.join(different, "node"), otherNodeScript, { mode: 0o755 });
  const query = [
    "-c",
    "exec node -p 'JSON.stringify({executable:process.execPath,version:process.version})'",
  ];
  await assert.rejects(execute("/bin/sh", query, { env: { PATH: empty } }), { code: 127 });
  const other = await execute("/bin/sh", query, { env: { PATH: different } });
  assert.equal(other.stdout.trim(), "different-system-node");
  for (const suffix of [empty, different]) {
    const selected = await execute("/bin/sh", query, {
      env: { PATH: `${path.dirname(runtime)}:${suffix}`, LANG: "C" },
    });
    assert.deepEqual(JSON.parse(selected.stdout), binding);
  }
});

test("colon-containing selected root refuses before any tool or configure spawn", async () => {
  const directory = await copyRoot();
  const colon = `${directory}:copy`;
  await rename(directory, colon);
  const before = await readdir(prepared.options.stagingRoot);
  await assert.rejects(buildQualifiedNodePtyCopy(colon, options(colon)), /PATH delimiter/);
  assert.deepEqual(await readdir(prepared.options.stagingRoot), before);
  assert.equal(
    hash(await readFile(path.join(colon, result.addon.path))),
    NODE_PTY_INPUTS.original,
  );
});

test("strict nested receipt rejects invented authority, inputs, and unknown coverage", () => {
  for (const mutate of [
    (value) => {
      value.qualification = true;
    },
    (value) => {
      value.coverage.allFileOpensTraced = true;
    },
    (value) => {
      value.inputs.node.headers.sha256 = "0".repeat(64);
    },
    (value) => {
      value.outputs.addon.path = "../installed/pty.node";
    },
    (value) => {
      value.commands[0].signal = "SIGTERM";
    },
    (value) => {
      value.evidence[0].path = "native-provenance/../escape";
    },
    (value) => {
      value.outputs.original.sha256 = "0".repeat(64);
    },
    (value) => {
      value.toolchain.tools[0].unmeasuredGrant = true;
    },
  ]) {
    const changed = structuredClone(record);
    mutate(changed);
    assert.throws(() => validateNodePtyBuildRecord(changed), /refused/);
  }
});

test("changed source fails before compiling or replacing the original copy", async () => {
  const directory = await copyRoot();
  await writeFile(path.join(directory, "node_modules/node-pty/src/unix/pty.cc"), "changed\n");
  await assert.rejects(
    buildQualifiedNodePtyCopy(directory, options(directory)),
    /selected input digest/,
  );
  assert.equal(
    hash(await readFile(path.join(directory, result.addon.path))),
    NODE_PTY_INPUTS.original,
  );
});

test("competing loader artifact and symlinked runtime never fall back to prebuild", async () => {
  const directory = await copyRoot();
  const competitor = path.join(directory, "node_modules/node-pty/build/Release");
  await mkdir(competitor, { recursive: true });
  await writeFile(path.join(competitor, "pty.node"), "not an addon");
  await assert.rejects(
    buildQualifiedNodePtyCopy(directory, options(directory)),
    /competing loader/,
  );
  const alias = path.join(directory, "node-alias");
  await symlink(path.join(directory, "runtime/node"), alias);
  await assert.rejects(
    buildQualifiedNodePtyCopy(directory, { ...options(directory), runtime: alias }),
    /canonical build path/,
  );
});

test("missing toolchain inputs and changed headers fail without a downloader", async () => {
  await assert.rejects(
    buildQualifiedNodePtyCopy(root, {
      ...options(root),
      toolchainRoot: prepared.options.stagingRoot,
    }),
    /fixed Linux-x64 recipe/,
  );
  const emptyHeaders = await mkdtemp(path.join(prepared.options.stagingRoot, "headers-"));
  await assert.rejects(
    buildQualifiedNodePtyCopy(prepared.root, { ...prepared.options, headersRoot: emptyHeaders }),
    /ENOENT/,
  );
});

test("original loader selects ONLY the copied native output; real open/resize/spawn/data/exit APIs work", async () => {
  const script = String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const root = process.argv[1];
    const pty = require(path.join(root,'node_modules/node-pty'));
    const loaded = Object.keys(require.cache).filter(name=>name.endsWith('/pty.node'));
    assert.deepEqual(loaded,[path.join(root,'node_modules/node-pty/prebuilds/linux-x64/pty.node')]);
    assert.equal(typeof pty.fork,'function');
    assert.equal(typeof pty.createTerminal,'function');
    assert.equal(typeof pty.open,'function');
    const pair=pty.native.open(80,24);
    pty.native.resize(pair.master,100,30,0,0);
    fs.closeSync(pair.master);fs.closeSync(pair.slave);
    const terminal=pty.spawn(process.execPath,['-e',
      "process.stdout.write('ready\\n');process.stdin.once('data',()=>{process.stdout.write('done\\n');process.stdin.pause();process.exitCode=23})"
    ],{cols:80,rows:24,env:{PATH:'/usr/bin:/bin',LANG:'C'},cwd:root});
    assert.ok(terminal.pid>0);
    let output='';let sent=false;
    terminal.onData(data=>{output+=data;if(!sent&&output.includes('ready')){sent=true;terminal.resize(100,30);terminal.write('input\n')}});
    terminal.onExit(event=>{assert.equal(event.exitCode,23);assert.ok(output.includes('done'));assert.equal(terminal.cols,100);assert.equal(terminal.rows,30);process.stdout.write('api-complete\n')});
  `;
  const child = await execute(path.join(root, "runtime/node"), ["-e", script, root], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    maxBuffer: 1024 * 1024,
  });
  assert.match(child.stdout, /api-complete/);
});

test("copied API still reports explicit signal termination of an owned PTY", async () => {
  const script = String.raw`
    const assert=require('node:assert/strict');
    const pty=require(process.argv[1]+'/node_modules/node-pty');
    const terminal=pty.spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{env:{PATH:'/usr/bin:/bin'},cwd:process.argv[1]});
    let signaled=false;
    terminal.onData(data=>{if(!signaled&&data.includes('ready')){signaled=true;terminal.kill('SIGTERM')}});
    terminal.onExit(event=>{assert.equal(event.signal,15);process.stdout.write('signal-api-complete\n')});
  `;
  const child = await execute(path.join(root, "runtime/node"), ["-e", script, root], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    maxBuffer: 1024 * 1024,
  });
  assert.match(child.stdout, /signal-api-complete/);
});
