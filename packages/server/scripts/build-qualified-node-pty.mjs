import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const NODE_PTY_INPUTS = Object.freeze({
  runtime: "2f822d544601dfff107f57d945b649d15c5bf6302595735a6bd9cdc7ee9669bd",
  headers: "961f52ed74924f083a19ebf7e08de5e10cba62523dbe338f01927a60aeb34003",
  source: "7019c550416824e08e4e9d8fce1344b8982b8502d43c367913835869d9771f5b",
  nodeAddonApi: "7480032e473f61cb7b6d0e78d5c19d24284e74e1f1820fd99432479835bc1427",
  npm: "86df90cf5ed1b46054f067a9dae3fe84dbda5bddff92d86f478f0cefb8fac999",
  original: "123792d8f22f36d519b21dfb6f4b716f9b18b9e579085ea2840d0773d88d35fd",
});
const ADDON = "node_modules/node-pty/prebuilds/linux-x64/pty.node";
const RECORD = "native-provenance/node-pty-source-build.json";
const EVIDENCE = "native-provenance/node-pty-source-build";
const MAX_RECORD = 8 * 1024 * 1024;
const COVERAGE = Object.freeze({
  commands: "actual-wrapper-and-generated-make",
  headers: "MD-system-dependencies",
  link: "map-trace-and-declared-inputs",
  tools: "measured-declared-existing-ci",
  syscallTrace: false,
  hermetic: false,
  reproducibleOldPrebuild: false,
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function json(value) {
  return JSON.stringify(canonical(value));
}
function refuse(message) {
  throw new Error(`Qualified node-pty build refused: ${message}`);
}
function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")
  )
    refuse("record keyset");
}
function text(value) {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > 4096 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    refuse("bounded string");
}
function digest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) refuse("digest");
}
function integer(value, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) refuse("integer");
}
function relative(value) {
  text(value);
  if (
    path.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    refuse("relative path");
}
function fileRecord(value) {
  keys(value, ["path", "realpath", "size", "sha256", "mode"]);
  text(value.path);
  text(value.realpath);
  integer(value.size, 536870912);
  integer(value.mode, 0o777);
  digest(value.sha256);
}
function treeRecord(value) {
  keys(value, ["path", "sha256", "fileCount", "bytes"]);
  text(value.path);
  digest(value.sha256);
  integer(value.fileCount, 20000);
  integer(value.bytes, 1073741824);
}
function list(value, check, limit = 10000) {
  if (!Array.isArray(value) || value.length > limit) refuse("bounded list");
  for (const item of value) check(item);
}
/** Descriptive build data only. A parsed receipt never grants execution authority. */
export function validateNodePtyBuildRecord(record) {
  if (Buffer.byteLength(json(record)) > MAX_RECORD) refuse("record size");
  keys(record, [
    "schemaVersion",
    "recipeId",
    "qualification",
    "inputs",
    "toolchain",
    "commands",
    "dependencies",
    "outputs",
    "coverage",
    "evidence",
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.recipeId !== "node-pty-linux-x64-source-v1" ||
    record.qualification !== false
  )
    refuse("record recipe");
  keys(record.inputs, ["source", "node", "nodeAddonApi", "nodeGyp"]);
  treeRecord(record.inputs.source);
  treeRecord(record.inputs.nodeAddonApi);
  treeRecord(record.inputs.nodeGyp);
  keys(record.inputs.node, ["runtime", "headers", "config", "common"]);
  fileRecord(record.inputs.node.runtime);
  treeRecord(record.inputs.node.headers);
  fileRecord(record.inputs.node.config);
  fileRecord(record.inputs.node.common);
  if (
    record.inputs.source.sha256 !== NODE_PTY_INPUTS.source ||
    record.inputs.nodeAddonApi.sha256 !== NODE_PTY_INPUTS.nodeAddonApi ||
    record.inputs.nodeGyp.sha256 !== NODE_PTY_INPUTS.npm ||
    record.inputs.node.runtime.sha256 !== NODE_PTY_INPUTS.runtime ||
    record.inputs.node.headers.sha256 !== NODE_PTY_INPUTS.headers
  )
    refuse("receipt selected inputs");
  keys(record.toolchain, ["baseline", "platform", "arch", "tools", "compilerPrograms"]);
  if (
    record.toolchain.baseline !== "existing-linux-ci" ||
    record.toolchain.platform !== "linux" ||
    record.toolchain.arch !== "x64"
  )
    refuse("toolchain baseline");
  list(
    record.toolchain.tools,
    (tool) => {
      keys(tool, ["role", "identity", "version"]);
      text(tool.role);
      text(tool.version);
      fileRecord(tool.identity);
    },
    128,
  );
  list(record.toolchain.compilerPrograms, fileRecord, 16);
  list(
    record.commands,
    (command) => {
      keys(command, ["role", "argv", "cwd", "exitCode", "signal"]);
      if (
        ![
          "tool-version",
          "compiler-program",
          "tool-libraries",
          "compiler-specs",
          "node-binding",
          "configure",
          "build",
          "compile",
          "link",
          "elf",
        ].includes(command.role)
      )
        refuse("command role");
      list(command.argv, text, 256);
      text(command.cwd);
      if (command.exitCode !== 0 || command.signal !== null) refuse("unsuccessful command");
    },
    64,
  );
  keys(record.dependencies, ["headers", "linkInputs"]);
  list(record.dependencies.headers, fileRecord);
  list(record.dependencies.linkInputs, fileRecord);
  keys(record.outputs, ["addon", "original", "preprocessed"]);
  fileRecord(record.outputs.addon);
  fileRecord(record.outputs.original);
  if (
    record.outputs.addon.path !== ADDON ||
    record.outputs.original.sha256 !== NODE_PTY_INPUTS.original
  )
    refuse("output identity");
  if (record.outputs.preprocessed !== null) fileRecord(record.outputs.preprocessed);
  if (json(record.coverage) !== json(COVERAGE)) refuse("coverage");
  list(
    record.evidence,
    (file) => {
      fileRecord(file);
      relative(file.path);
      if (!file.path.startsWith(`${EVIDENCE}/`)) refuse("evidence path");
    },
    128,
  );
  return record;
}
function within(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}
async function identity(file, label = file) {
  const resolved = await realpath(file);
  const handle = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let primary;
  let value;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 536870912n) refuse("input file");
    const hash = createHash("sha256");
    let total = 0n;
    for (;;) {
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += BigInt(bytesRead);
      if (total > before.size) refuse("growing input");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (total !== before.size) refuse("input length changed");
    const current = await lstat(resolved, { bigint: true });
    for (const key of ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"])
      if (before[key] !== after[key] || before[key] !== current[key]) refuse("changing input");
    if ((await realpath(file)) !== resolved) refuse("changing input route");
    value = {
      path: label,
      realpath: label === file ? resolved : label,
      size: Number(after.size),
      sha256: hash.digest("hex"),
      mode: Number(after.mode & 0o777n),
    };
  } catch (error) {
    primary = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (primary)
      throw new AggregateError([primary, error], "Input read and close failed", { cause: primary });
    throw error;
  }
  if (primary) throw primary;
  return value;
}
async function tree(root) {
  const rows = [];
  let bytes = 0;
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) await visit(file);
      else if (stat.isSymbolicLink()) {
        if (!within(root, await realpath(file))) refuse("escaping tree link");
        rows.push({ path: path.relative(root, file), link: await readlink(file) });
      } else {
        const item = await identity(file);
        bytes += item.size;
        rows.push({ path: path.relative(root, file), size: item.size, sha256: item.sha256 });
      }
      if (rows.length > 20000 || bytes > 1073741824) refuse("input tree bounds");
    }
  }
  await visit(root);
  rows.sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)));
  return { path: root, sha256: sha(json(rows)), fileCount: rows.length, bytes };
}
async function missing(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  refuse("existing output or competing loader");
}
async function roots(root, options) {
  keys(options, ["runtime", "headersRoot", "nodeGypRoot", "toolchainRoot", "stagingRoot"]);
  for (const file of [root, ...Object.values(options)]) {
    text(file);
    if (file.includes(path.delimiter)) refuse("PATH delimiter in build path");
    if (!path.isAbsolute(file) || /\s/.test(file) || (await realpath(file)) !== file)
      refuse("canonical build path");
  }
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    options.toolchainRoot !== "/usr" ||
    options.runtime !== path.join(root, "runtime/node")
  )
    refuse("fixed Linux-x64 recipe");
  if (within(root, options.stagingRoot) || within(options.stagingRoot, root))
    refuse("overlapping staging");
  await missing(path.join(root, RECORD));
  await missing(path.join(root, EVIDENCE));
  for (const name of ["Release", "Debug"])
    await missing(path.join(root, "node_modules/node-pty/build", name, "pty.node"));
}
function buildEnvironment(home, runtime) {
  return {
    PATH: `${path.dirname(runtime)}:/usr/bin:/bin`,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    SYSROOT_PATH: "",
    npm_config_arch: "x64",
    CC: "/usr/bin/gcc",
    CXX: "/usr/bin/g++",
    PYTHON: "/usr/bin/python3",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}
async function run(commands, role, executable, args, cwd, env) {
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  let size = 0;
  let failure;
  function collect(chunk) {
    size += chunk.length;
    if (size <= 8 * 1024 * 1024) chunks.push(chunk);
    else failure ??= new Error("Bounded build output exceeded");
  }
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => {
    failure ??= error;
  });
  const result = await new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  commands.push({
    role,
    argv: [executable, ...args],
    cwd,
    exitCode: result.code,
    signal: result.signal,
  });
  const output = Buffer.concat(chunks).toString("utf8");
  await writeFile(path.join(cwd, `command-${commands.length}-${role}.log`), output, { flag: "wx" });
  if (failure) throw failure;
  if (result.code !== 0 || result.signal !== null)
    refuse(`failed ${role}; staging evidence preserved`);
  return output;
}
async function compilerPrograms(commands, env, cwd) {
  const programs = [];
  for (const name of ["cc1plus", "collect2", "as", "ld"]) {
    const answer = (
      await run(
        commands,
        "compiler-program",
        "/usr/bin/g++",
        [`-print-prog-name=${name}`],
        cwd,
        env,
      )
    ).trim();
    const file = path.isAbsolute(answer) ? answer : path.join("/usr/bin", answer);
    if (!within("/usr", await realpath(file))) refuse("compiler program outside baseline");
    programs.push(await identity(file));
  }
  return programs;
}
async function toolLibraries(commands, files, cwd, env) {
  const names = [];
  const reports = [];
  for (const file of files) {
    const output = await run(commands, "tool-libraries", "/usr/bin/ldd", [file], cwd, env);
    if (output.includes("not found")) refuse("missing baseline library");
    reports.push({ file, output });
    for (const match of output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)/gm)) names.push(match[1]);
  }
  return { identities: await dependencies(names), reports };
}
async function dependencies(files) {
  const result = [];
  for (const file of [...new Set(files)].sort()) result.push(await identity(file));
  return result;
}
async function checkCopiedSource(original, copied) {
  for (const name of await readdir(original)) {
    const source = path.join(original, name);
    const target = path.join(copied, name);
    const stat = await lstat(source);
    if (stat.isDirectory()) await checkCopiedSource(source, target);
    else {
      const expected = await identity(source);
      const actual = await identity(target);
      if (
        expected.sha256 !== actual.sha256 ||
        expected.size !== actual.size ||
        expected.mode !== actual.mode
      )
        refuse("staging source changed");
    }
  }
}
async function makeReceipts(stage, commands) {
  const records = [];
  const makefiles = [];
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      if ((await lstat(file)).isDirectory()) await visit(file);
      else if (name.endsWith(".command.json"))
        records.push(JSON.parse(await readFile(file, "utf8")));
      else if (name === "Makefile" || name.endsWith(".mk") || name === "config.gypi")
        makefiles.push(file);
    }
  }
  await visit(stage);
  if (
    records.filter((row) => row.role === "compile").length !== 1 ||
    records.filter((row) => row.role === "link").length !== 1
  )
    refuse("unexpected compiler invocation set");
  commands.push(...records);
  return makefiles;
}
async function compilerWrapper(stage, runtime) {
  const wrapper = path.join(stage, "cxx.mjs");
  const script = `#!${runtime}\nimport {spawnSync} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\nconst stage=${JSON.stringify(stage)};\nconst incoming=process.argv.slice(2);\nconst role=incoming.includes('-c')?'compile':'link';\nconst extra=role==='compile'?['-save-temps=obj','-Xpreprocessor','-dD','-MD','-MF',stage+'/pty.d','-v']:['-Wl,-Map,'+stage+'/pty.map','-Wl,--trace','-v'];\nconst base=[];
for(let index=0;index<incoming.length;index++){
  const flag=incoming[index];
  if(role==='compile'&&(flag==='-MD'||flag==='-MMD'))continue;
  if(role==='compile'&&flag==='-MF'){if(!incoming[index+1])throw new Error('Missing dependency output');index++;continue;}
  base.push(flag);
}
const argv=[...base,...extra];\nconst r=spawnSync('/usr/bin/g++',argv,{stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});\nwriteFileSync(stage+'/'+role+'.command.json',JSON.stringify({role,argv:['/usr/bin/g++',...argv],cwd:process.cwd(),exitCode:r.status,signal:r.signal}));\nif(r.stdout)process.stdout.write(r.stdout);\nif(r.stderr)process.stderr.write(r.stderr);\nif(r.error||r.signal||r.status!==0)process.exitCode=1;\n`;
  await writeFile(wrapper, script, { mode: 0o755, flag: "wx" });
  return wrapper;
}
async function evidence(root, entries) {
  const directory = path.join(root, EVIDENCE);
  await mkdir(directory, { recursive: true });
  const records = [];
  for (const [name, bytes] of entries) {
    relative(name);
    const file = path.join(directory, name);
    await writeFile(file, bytes, { mode: 0o444, flag: "wx" });
    records.push(await identity(file, `${EVIDENCE}/${name}`));
  }
  return records;
}
async function selectedInputs(root, options) {
  const source = path.join(root, "node_modules/node-pty");
  const api = path.join(root, "node_modules/node-addon-api");
  const npm = path.dirname(path.dirname(options.nodeGypRoot));
  if (options.nodeGypRoot !== path.join(npm, "node_modules/node-gyp")) refuse("bundled GYP route");
  const inputs = {
    source: await tree(source),
    nodeAddonApi: await tree(api),
    nodeGyp: await tree(npm),
    node: {
      runtime: await identity(options.runtime),
      headers: await tree(path.join(options.headersRoot, "include/node")),
      config: await identity(path.join(options.headersRoot, "include/node/config.gypi")),
      common: await identity(path.join(options.headersRoot, "include/node/common.gypi")),
    },
  };
  if (
    inputs.source.sha256 !== NODE_PTY_INPUTS.source ||
    inputs.nodeAddonApi.sha256 !== NODE_PTY_INPUTS.nodeAddonApi ||
    inputs.nodeGyp.sha256 !== NODE_PTY_INPUTS.npm ||
    inputs.node.runtime.sha256 !== NODE_PTY_INPUTS.runtime ||
    inputs.node.headers.sha256 !== NODE_PTY_INPUTS.headers
  )
    refuse("selected input digest");
  const original = await identity(path.join(root, ADDON), ADDON);
  if (original.sha256 !== NODE_PTY_INPUTS.original) refuse("original addon");
  return { source, api, npm, inputs, original };
}

async function compiledEvidence(stage, work, commands, env) {
  const compile = commands.find((command) => command.role === "compile");
  if (compile.cwd !== path.join(work, "build")) refuse("unexpected compiler working directory");
  const depfile = (await readFile(path.join(stage, "pty.d"), "utf8")).replace(/\\\r?\n/g, " ");
  const headerNames = depfile
    .slice(depfile.indexOf(":") + 1)
    .trim()
    .split(/\s+/)
    .map((name) => path.resolve(compile.cwd, name));
  if (!headerNames.length || headerNames.some((name) => name.includes("\\")))
    refuse("dependency format");
  const headers = await dependencies(headerNames);
  if (
    !headers.some((item) => item.path.endsWith("/napi.h")) ||
    !headers.some((item) => item.path.startsWith("/usr/include/"))
  )
    refuse("missing system/header dependency evidence");
  const map = await readFile(path.join(stage, "pty.map"), "utf8");
  const linkNames = [...map.matchAll(/^LOAD (\/[^\s()]+)/gm)]
    .map((match) => match[1])
    .filter((name) => !within(stage, name));
  const linkInputs = await dependencies(linkNames);
  if (!linkInputs.length) refuse("missing linker inputs");
  const output = path.join(work, "build/Release/pty.node");
  const raw = await readFile(output);
  if (
    raw.subarray(0, 4).toString("hex") !== "7f454c46" ||
    raw.readUInt16LE(16) !== 3 ||
    raw.readUInt16LE(18) !== 62
  )
    refuse("Linux-x64 shared ELF");
  const elf = await run(
    commands,
    "elf",
    "/usr/bin/readelf",
    ["-h", "-S", "-l", "-d", "-s", "-r", "-W", output],
    stage,
    env,
  );
  if (
    !elf.includes("napi_register_module_v1") ||
    !elf.includes("node_api_module_get_api_version_v1")
  )
    refuse("addon exports");
  return { headers, map, linkInputs, output, raw, elf };
}

async function appendPreprocessedEvidence(entries, preprocessed) {
  let preprocessedBytes = null;
  try {
    preprocessedBytes = await readFile(preprocessed);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (preprocessedBytes !== null) {
    const definitions = preprocessedBytes.toString("utf8");
    if (
      !/^#define NAPI_VERSION 8$/m.test(definitions) ||
      !/^#define NAPI_CPP_EXCEPTIONS/m.test(definitions)
    )
      refuse("actual NAPI/exception preprocessing");
    entries.push(["pty.ii", preprocessedBytes]);
  }
}

/** Fixed build operation on a disposable COPY, never a runtime eligibility port. */
export async function buildQualifiedNodePtyCopy(root, options) {
  await roots(root, options);
  const { source, api, npm, inputs, original } = await selectedInputs(root, options);
  const stage = await mkdtemp(path.join(options.stagingRoot, "nodepty-"));
  const env = buildEnvironment(stage, options.runtime);
  const commands = [];
  const tools = [];
  for (const [role, file] of [
    ["c", "/usr/bin/gcc"],
    ["cxx", "/usr/bin/g++"],
    ["make", "/usr/bin/make"],
    ["python", "/usr/bin/python3"],
    ["readelf", "/usr/bin/readelf"],
    ["ldd", "/usr/bin/ldd"],
  ]) {
    const item = await identity(file);
    if (!within("/usr", item.realpath)) refuse("toolchain route");
    const version = (await run(commands, "tool-version", file, ["--version"], stage, env)).split(
      "\n",
    )[0];
    tools.push({ role, identity: item, version });
  }
  tools.push({
    role: "gyp-shell",
    identity: await identity("/bin/sh"),
    version: "original GYP command shell",
  });
  const programs = await compilerPrograms(commands, env, stage);
  const libraries = await toolLibraries(
    commands,
    [
      ...tools.filter((tool) => tool.role !== "ldd").map((tool) => tool.identity.path),
      ...programs.map((item) => item.path),
      options.runtime,
    ],
    stage,
    env,
  );
  for (const item of libraries.identities)
    tools.push({
      role: "baseline-library",
      identity: item,
      version: "declared by measured baseline ldd",
    });
  const specs = await run(commands, "compiler-specs", "/usr/bin/g++", ["-dumpspecs"], stage, env);
  const work = path.join(stage, "node_modules/node-pty");
  await mkdir(path.dirname(work), { recursive: true });
  await cp(source, work, { recursive: true, dereference: false });
  const copiedApi = path.join(stage, "node_modules/node-addon-api");
  await cp(api, copiedApi, { recursive: true, dereference: false });
  await checkCopiedSource(source, work);
  await checkCopiedSource(api, copiedApi);
  env.CXX = await compilerWrapper(stage, options.runtime);
  const gyp = path.join(options.nodeGypRoot, "bin/node-gyp.js");
  const bindingText = await run(
    commands,
    "node-binding",
    "/bin/sh",
    ["-c", "exec node -p 'JSON.stringify({executable:process.execPath,version:process.version})'"],
    work,
    env,
  );
  const nodeBinding = JSON.parse(bindingText);
  keys(nodeBinding, ["executable", "version"]);
  if (nodeBinding.executable !== options.runtime || nodeBinding.version !== "v22.23.5")
    refuse("GYP selected Node binding");
  if (json(await identity(nodeBinding.executable)) !== json(inputs.node.runtime))
    refuse("GYP selected Node changed");
  const configured = await run(
    commands,
    "configure",
    options.runtime,
    [
      gyp,
      "configure",
      "--release",
      "--arch=x64",
      `--nodedir=${options.headersRoot}`,
      "--python=/usr/bin/python3",
    ],
    work,
    env,
  );
  const built = await run(
    commands,
    "build",
    options.runtime,
    [gyp, "build", "--release", "--jobs=1"],
    work,
    env,
  );
  const makefiles = await makeReceipts(stage, commands);
  const { headers, map, linkInputs, output, raw, elf } = await compiledEvidence(
    stage,
    work,
    commands,
    env,
  );
  const preprocessed = path.join(work, "build/Release/obj.target/pty/src/unix/pty.ii");
  const entries = [
    ["build-environment.json", json(env)],
    ["node-binding.json", json(nodeBinding)],
    ["configure.txt", configured],
    ["build.txt", built],
    ["compiler-specs.txt", specs],
    ["tool-libraries.json", json(libraries.reports)],
    ["commands.json", json(commands)],
    ["headers.json", json(headers)],
    ["link-inputs.json", json(linkInputs)],
    ["link.map", map],
    ["elf.txt", elf],
    ["original-pty.node.gz", gzipSync(await readFile(path.join(root, ADDON)))],
  ];
  for (let i = 0; i < makefiles.length; i++)
    entries.push([`generated-${i}.txt`, await readFile(makefiles[i])]);
  await appendPreprocessedEvidence(entries, preprocessed);
  // Fresh source/tool checks after all compiler work. Nothing is installed on failure.
  for (const [directory, expected] of [
    [source, inputs.source],
    [api, inputs.nodeAddonApi],
    [npm, inputs.nodeGyp],
    [path.join(options.headersRoot, "include/node"), inputs.node.headers],
  ])
    if ((await tree(directory)).sha256 !== expected.sha256) refuse("changed build input tree");
  await checkCopiedSource(source, work);
  await checkCopiedSource(api, copiedApi);
  for (const item of [
    inputs.node.runtime,
    inputs.node.config,
    inputs.node.common,
    ...tools.map((tool) => tool.identity),
    ...programs,
    ...headers,
    ...linkInputs,
  ])
    if (json(await identity(item.path)) !== json(item)) refuse("changed build input");
  const evidenceFiles = await evidence(root, entries);
  const addon = { path: ADDON, realpath: ADDON, size: raw.length, sha256: sha(raw), mode: 0o555 };
  const record = validateNodePtyBuildRecord({
    schemaVersion: 1,
    recipeId: "node-pty-linux-x64-source-v1",
    qualification: false,
    inputs,
    toolchain: {
      baseline: "existing-linux-ci",
      platform: "linux",
      arch: "x64",
      tools,
      compilerPrograms: programs,
    },
    commands,
    dependencies: { headers, linkInputs },
    outputs: {
      addon,
      original,
      preprocessed: evidenceFiles.find((file) => file.path.endsWith("/pty.ii")) ?? null,
    },
    coverage: COVERAGE,
    evidence: evidenceFiles,
  });
  const temporary = path.join(root, `${ADDON}.source-build`);
  await copyFile(output, temporary, constants.COPYFILE_EXCL);
  await chmod(temporary, addon.mode);
  if ((await identity(temporary)).sha256 !== addon.sha256) refuse("copied output changed");
  await writeFile(path.join(root, RECORD), json(record) + "\n", { mode: 0o444, flag: "wx" });
  await rename(temporary, path.join(root, ADDON));
  const publishedRecord = await identity(path.join(root, RECORD), RECORD);
  return {
    addon: { path: addon.path, size: addon.size, sha256: addon.sha256, mode: addon.mode },
    record: {
      path: publishedRecord.path,
      size: publishedRecord.size,
      sha256: publishedRecord.sha256,
    },
  };
}
