// Fixed Linux CI retention. All returned records are DATA, never execution authority.
import { constants } from "node:fs";
import { open, lstat, realpath, readdir, mkdir, mkdtemp, writeFile, rename, chmod, rmdir, readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const recordPath = "python/provenance/identity.json";
const probePath = "python/provenance/probe.py";
const memberLimit = 10000;
const tarLimit = 512 * 1024 * 1024;
const zipLimit = 128 * 1024 * 1024;
const leafLimit = 32 * 1024 * 1024;
const recordLimit = 4 * 1024 * 1024;
const flags = ["-I", "-S", "-B"];
const excludedTests = ["test", "unittest/test", "idlelib/idle_test", "tkinter/test", "ctypes/test", "distutils/tests", "lib2to3/tests", "sqlite3/test"];
const excludedComponents = new Set(["site-packages", "dist-packages", "__pycache__"]);
const digest = (raw) => createHash("sha256").update(raw).digest("hex");
const stamp = (s) => [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(":");
const fail = (reason) => { throw new Error(`Retained Python HOLD: ${reason}`); };
const require = (condition, reason) => { if (!condition) fail(reason); };
function exact(value, keys) {
  require(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"), "closed record keys");
}
function relative(value) {
  require(typeof value === "string" && value.length <= 4096 && !value.includes("\\") && !value.includes("\0") && !path.isAbsolute(value) && value.split("/").every((p) => p && p !== "." && p !== ".."), "relative member");
  return value;
}
function identity(row) {
  exact(row, ["path","mode","size","sha256"]);
  relative(row.path);
  require(Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= leafLimit && [0o444,0o555].includes(row.mode) && typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256), "file identity");
}
async function protectedSource(file) {
  require(path.isAbsolute(file) && await realpath(file) === file, "noncanonical source");
  for (let current = path.dirname(file);; current = path.dirname(current)) {
    const s = await lstat(current);
    require(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022), "unprotected source ancestry");
    if (current === "/") break;
  }
}
async function bytes(file, limit, source = false) {
  if (source) await protectedSource(file);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({bigint:true});
    require(before.isFile() && before.nlink === 1n && before.size <= BigInt(limit) && !(before.mode & 0o022n), "unsafe regular input");
    if (source) require(before.uid === 0n && !(before.mode & 0o7000n), "source owner/mode");
    const raw = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < raw.length) {
      const read = await fd.read(raw, used, raw.length-used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
      require(used <= Number(before.size), "input grew");
    }
    require(used === Number(before.size) && stamp(before) === stamp(await fd.stat({bigint:true})) && stamp(before) === stamp(await lstat(file,{bigint:true})), "input changed");
    return {raw:raw.subarray(0,used),mode:Number(before.mode & 0o777n)};
  } finally { await fd.close(); }
}
function excluded(name) {
  return name.split("/").some((p) => excludedComponents.has(p)) || /\.(?:pyc|pyo)$/.test(name) || excludedTests.some((p) => name === p || name.startsWith(p+"/"));
}
async function inventory(root) {
  const files = [], directories = [];
  async function visit(directory, prefix) {
    const info = await lstat(directory);
    require(info.isDirectory() && !info.isSymbolicLink(), "unsafe directory");
    if (prefix) directories.push(prefix);
    for (const name of (await readdir(directory)).sort()) {
      const member = prefix ? prefix+"/"+name : name;
      relative(member);
      const file = path.join(directory,name), s = await lstat(file);
      require(files.length+directories.length < memberLimit, "member budget");
      if (s.isDirectory() && !s.isSymbolicLink()) await visit(file,member);
      else {
        require(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, "special/symlink/hardlink payload");
        const data = await bytes(file,leafLimit);
        files.push({path:member,mode:data.mode,size:data.raw.length,sha256:digest(data.raw)});
      }
    }
  }
  await visit(root, "");
  files.sort((a,b) => a.path < b.path ? -1 : Number(a.path > b.path));
  directories.sort();
  return {files,directories};
}
function budget(files, directories, reserveRecord = false) {
  const round = (n) => Math.ceil(n/512)*512;
  // Charge a PAX header and bounded path metadata for EVERY entry, plus two outer
  // producer sidecars up to4MiB each. Final actual TAR/ZIP gate belongs integration.
  const rows = [...files, ...directories.map((name) => ({path:name,size:0}))];
  let total = 1024 + 2*(recordLimit+8192);
  for (const row of rows) total += 1024+round(Buffer.byteLength(row.path)+256)+round(row.size);
  if (reserveRecord) total += recordLimit+8192;
  require(rows.length+4+(reserveRecord?1:0) <= memberLimit && total <= tarLimit, "aggregate TAR/member budget");
  return {fileCount:files.length,directoryCount:directories.length,regularBytes:files.reduce((n,r) => n+r.size,0),tarUpperBound:total,zipLimit,tarLimit,memberLimit};
}
function environment() { return {PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:os.userInfo().homedir}; }
async function probe(executable, script) {
  const result = await execute(executable,[...flags,script],{env:environment(),timeout:15000,maxBuffer:65536});
  require(result.stderr === "" && Buffer.byteLength(result.stdout) <= 65536, "probe output");
  const value = JSON.parse(result.stdout);
  require(value.schemaVersion === 1 && value.qualification === false && value.implementation === "cpython" && value.version.length === 3 && value.version[0] === 3 && value.platlibdir === "lib", "unsupported CPython layout");
  require(value.flags.isolated === 1 && value.flags.noSite === 1 && value.flags.dontWriteBytecode === 1 && value.prefix === value.basePrefix && value.execPrefix === value.baseExecPrefix, "isolated/venv flags");
  return value;
}
function normalizeProbe(value, root) {
  const prefix = path.join(root,"python");
  const inside = (location) => {
    const name = path.relative(root,location);
    require(location.startsWith(prefix+"/") || location === prefix, "host Python lookup fallback");
    return relative(name);
  };
  for (const key of ["prefix","execPrefix","basePrefix","baseExecPrefix"]) require(value[key] === prefix, "relocated prefix");
  require(value.executable === path.join(prefix,"bin/python3"), "relocated executable");
  const abi=value.version.slice(0,2).join(".");
  const expectedPath=[path.join(prefix,"lib",`python${value.version[0]}${value.version[1]}.zip`),path.join(prefix,"lib",`python${abi}`),path.join(prefix,"lib",`python${abi}`,"lib-dynload")];
  require(JSON.stringify(value.path)===JSON.stringify(expectedPath), "unexpected isolated lookup roots");
  return {...value,...Object.fromEntries(["executable","prefix","execPrefix","basePrefix","baseExecPrefix","stdlib","platstdlib","extensionDirectory"].map((k) => [k,inside(value[k])])),
    path:value.path.map(inside),modules:value.modules.map((r) => ({name:r.name,origin:["built-in","frozen"].includes(r.origin)?r.origin:inside(r.origin)})),
    // External ELF maps are explicitly FUTURE systemClosure inputs, never qualification.
    nativeMapFiles:value.nativeMapFiles.map((p) => p.startsWith(prefix+"/")?inside(p):p)};
}
async function sourcePackages(names) {
  const owners = new Set();
  for (let offset=0;offset<names.length;offset+=32) {
    const result = await execute("/usr/bin/dpkg-query",["-S",...names.slice(offset,offset+32)],{env:environment(),timeout:15000,maxBuffer:65536});
    require(result.stderr === "", "package ownership stderr");
    for (const line of result.stdout.trim().split("\n")) {
      const at = line.indexOf(": ");
      require(at > 0, "package ownership record");
      for (const owner of line.slice(0,at).split(", ")) {
        require(/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/.test(owner), "package ownership name");
        owners.add(owner);
      }
    }
    require(owners.size <= 32, "source package count");
  }
  const result = await execute("/usr/bin/dpkg-query",["-W","-f","${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n",...Array.from(owners).sort()],{env:environment(),timeout:15000,maxBuffer:65536});
  require(result.stderr === "" && result.stdout.trim(), "package provenance unavailable");
  return result.stdout.trim().split("\n").map((line) => {
    const fields = line.split("\t"); require(fields.length === 4 && fields.every(Boolean), "package source provenance");
    return {package:fields[0],version:fields[1],sourcePackage:fields[2],sourceVersion:fields[3]};
  });
}
function observation(value, retained) {
  exact(value,["schemaVersion","qualification","implementation","version","cacheTag","abiFlags","platlibdir","executable","prefix","execPrefix","basePrefix","baseExecPrefix","path","flags","stdlib","platstdlib","extensionDirectory","modules","nativeMapFiles","build"]);
  const text=(s) => require(typeof s === "string" && Buffer.byteLength(s)<=8192 && !s.includes("\0"), "probe text");
  require(value.schemaVersion===1 && value.qualification===false && value.implementation==="cpython" && value.abiFlags==="" && value.platlibdir==="lib" && Array.isArray(value.version) && value.version.length===3 && value.version.every((n) => Number.isSafeInteger(n) && n>=0 && n<=65535) && value.version[0]===3, "observed CPython ABI");
  observationLists(value,retained,text);
}
function observationLists(value,retained,text) {
  for(const k of ["cacheTag","abiFlags","executable","prefix","execPrefix","basePrefix","baseExecPrefix","stdlib","platstdlib","extensionDirectory"]) text(value[k]);
  exact(value.flags,["isolated","noSite","dontWriteBytecode"]);
  require(Object.values(value.flags).every((n) => n===1), "observed isolation");
  require(Array.isArray(value.path) && value.path.length<=16 && Array.isArray(value.modules) && value.modules.length<=512 && Array.isArray(value.nativeMapFiles) && value.nativeMapFiles.length<=256, "probe list bound");
  const location=(p) => { text(p); if(retained) relative(p); else require(path.isAbsolute(p) && path.normalize(p)===p, "probe absolute path"); };
  for(const p of value.path) location(p);
  let previous="";
  for(const row of value.modules) {
    exact(row,["name","origin"]); text(row.name); text(row.origin);
    require(row.name>previous, "probe module order"); previous=row.name;
    if(!["built-in","frozen"].includes(row.origin)) location(row.origin);
  }
  for(const p of value.nativeMapFiles) { text(p); require(path.isAbsolute(p) || (retained && p.startsWith("python/")), "native map path"); }
  exact(value.build,["SOABI","EXT_SUFFIX","CONFIG_ARGS","MULTIARCH","LDLIBRARY"]);
  for(const v of Object.values(value.build)) text(v);
}
function sourceRecord(source) {
  const record={source};
  exact(record.source,["requestedExecutable","resolvedExecutable","executableIdentity","version","implementation","cacheTag","abiFlags","platlibdir","stdlib","platstdlib","extensionDirectory","packageProvenance"]);
  require(record.source.requestedExecutable === "/usr/bin/python3" && record.source.implementation === "cpython" && record.source.platlibdir === "lib" && Array.isArray(record.source.version) && record.source.version.length === 3 && record.source.version.every((n) => Number.isSafeInteger(n) && n >= 0) && record.source.version[0] === 3, "source layout");
  const abi = record.source.version.slice(0,2).join(".");
  require(record.source.abiFlags==="" && typeof record.source.cacheTag==="string" && record.source.cacheTag.length<=128 && record.source.stdlib===`/usr/lib/python${abi}` && record.source.platstdlib===record.source.stdlib && record.source.extensionDirectory===record.source.stdlib+"/lib-dynload", "finite source ABI paths");
  sourceExecutable(record.source);
  packageEvidence(record.source.packageProvenance);
  return abi;
}
function sourceExecutable(source) {
  const record={source};
  const executable=record.source.executableIdentity;
  exact(executable,["path","mode","size","sha256"]);
  require(typeof record.source.resolvedExecutable==="string" && /^\/usr\/bin\/python3\.[0-9]+$/.test(record.source.resolvedExecutable) && executable.path===record.source.resolvedExecutable && Number.isInteger(executable.mode) && executable.mode>=0 && executable.mode<=0o777 && !(executable.mode&0o022) && Number.isSafeInteger(executable.size) && executable.size>0 && executable.size<=leafLimit && typeof executable.sha256==="string" && /^[a-f0-9]{64}$/.test(executable.sha256), "source executable identity");
}
function packageEvidence(packageProvenance) {
  const record={source:{packageProvenance}};
  require(Array.isArray(record.source.packageProvenance) && record.source.packageProvenance.length>0 && record.source.packageProvenance.length<=32, "package evidence");
  for(const row of record.source.packageProvenance) {
    exact(row,["package","version","sourcePackage","sourceVersion"]);
    for(const v of Object.values(row)) require(typeof v==="string" && v.length>0 && v.length<=1024 && !/[\0\r\n]/.test(v), "package evidence text");
  }
}
function retainedInventory(record,abi) {
  exact(record.layout,["executable","stdlib","extensionDirectory","argvFlags"]);
  require(JSON.stringify(record.layout) === JSON.stringify({executable:"python/bin/python3",stdlib:`python/lib/python${abi}`,extensionDirectory:`python/lib/python${abi}/lib-dynload`,argvFlags:flags}), "fixed retained layout");
  require(Array.isArray(record.files) && record.files.length && record.files.length < memberLimit && Array.isArray(record.sourceFiles) && record.sourceFiles.length < memberLimit, "inventory count");
  let previous = "";
  const files = new Map();
  for (const row of record.files) {
    identity(row);
    require(row.path.startsWith("python/") && row.path !== recordPath && row.path > previous && row.mode === (row.path === "python/bin/python3"?0o555:0o444), "closed sorted retained inventory");
    if(row.path.startsWith(record.layout.stdlib+"/")) require(!excluded(row.path.slice(record.layout.stdlib.length+1)), "excluded source/cache input");
    previous=row.path; files.set(row.path,row);
  }
  sourceMappings(record,files,abi);
  return files;
}
function sourceMappings(record,files,abi) {
  const mapped = new Set();
  let previous="";
  for (const row of record.sourceFiles) {
    exact(row,["sourcePath","path","sourceMode","mode","size","sha256"]);
    require(typeof row.sourcePath === "string" && path.isAbsolute(row.sourcePath) && Number.isInteger(row.sourceMode) && row.sourceMode >= 0 && row.sourceMode <= 0o777 && !(row.sourceMode & 0o022) && !mapped.has(row.path), "source file mapping");
    require(JSON.stringify(files.get(row.path)) === JSON.stringify({path:row.path,mode:row.mode,size:row.size,sha256:row.sha256}), "source/retained bytes mapping");
    const expectedSource=row.path==="python/bin/python3"?record.source.resolvedExecutable:record.source.stdlib+"/"+row.path.slice(record.layout.stdlib.length+1);
    require(row.path>previous && (row.path==="python/bin/python3" || row.path.startsWith(record.layout.stdlib+"/")) && row.sourcePath===expectedSource, "source path mapping/order");
    previous=row.path;
    mapped.add(row.path);
  }
  require(files.has(probePath) && files.has("python/bin/python3") && files.has(`python/lib/python${abi}/os.py`) && files.has(`python/lib/python${abi}/encodings/__init__.py`) && mapped.size === files.size-1 && !mapped.has(probePath), "complete source coverage");
  const executable=record.source.executableIdentity;
  const capturedInterpreter=record.sourceFiles.find((row) => row.path==="python/bin/python3");
  require(capturedInterpreter.sourceMode===executable.mode && capturedInterpreter.size===executable.size && capturedInterpreter.sha256===executable.sha256, "interpreter source/retained binding");
}
function recordObservations(record,files) {
  require(Array.isArray(record.protectedAbsent) && record.protectedAbsent.length < memberLimit && record.protectedAbsent.every((p,i,a) => relative(p) && p.startsWith("python/") && (!i || a[i-1] < p)), "absence inventory");
  exact(record.observed,["source","relocated"]);
  observation(record.observed.source,false);
  require(JSON.stringify(record.observed.source.version)===JSON.stringify(record.source.version) && record.observed.source.executable===record.source.resolvedExecutable && record.observed.source.stdlib===record.source.stdlib && record.observed.source.extensionDirectory===record.source.extensionDirectory, "observed source binding");
  if(record.observed.relocated!==null) {
    observation(record.observed.relocated,true);
    const value=record.observed.relocated;
    require(JSON.stringify(value.version)===JSON.stringify(record.source.version) && [value.prefix,value.execPrefix,value.basePrefix,value.baseExecPrefix].every((p) => p==="python") && value.executable===record.layout.executable && value.stdlib===record.layout.stdlib && value.platstdlib===record.layout.stdlib && value.extensionDirectory===record.layout.extensionDirectory, "observed retained binding");
    const zip=`python/lib/python${record.source.version[0]}${record.source.version[1]}.zip`;
    require(JSON.stringify(value.path)===JSON.stringify([zip,record.layout.stdlib,record.layout.extensionDirectory]) && value.modules.every((row) => ["built-in","frozen"].includes(row.origin) || files.has(row.origin)), "observed retained import inventory");
  }
}
function validateRecord(record) {
  exact(record,["schemaVersion","kind","qualification","source","layout","sourceFiles","files","protectedAbsent","observed","budgets"]);
  require(record.schemaVersion === 1 && record.kind === "retained-cpython-layout-v1" && record.qualification === false, "record kind");
  const abi=sourceRecord(record.source);
  const files=retainedInventory(record,abi);
  recordObservations(record,files);
  exact(record.budgets,["fileCount","directoryCount","regularBytes","tarUpperBound","zipLimit","tarLimit","memberLimit"]);
  require(record.budgets.zipLimit === zipLimit && record.budgets.tarLimit === tarLimit && record.budgets.memberLimit === memberLimit && Object.values(record.budgets).every((n) => Number.isSafeInteger(n) && n>=0) && record.budgets.tarUpperBound<=tarLimit && record.budgets.fileCount+record.budgets.directoryCount<memberLimit, "fixed budget declarations");
  return record;
}

/** DATA comparison only: expected identity is not protected enrollment authority. No exec. */
export async function assertRetainedQualifiedPython(root, expectedRecordFileIdentity) {
  identity(expectedRecordFileIdentity);
  require(expectedRecordFileIdentity.path === recordPath && expectedRecordFileIdentity.mode === 0o444 && expectedRecordFileIdentity.size <= recordLimit, "fixed record identity");
  const prefix = path.join(root,"python");
  require(await realpath(prefix) === prefix, "canonical retained prefix");
  const data = await bytes(path.join(root,recordPath),recordLimit);
  require(data.mode === 0o444 && data.raw.length === expectedRecordFileIdentity.size && digest(data.raw) === expectedRecordFileIdentity.sha256, "raw record identity");
  const record = validateRecord(JSON.parse(data.raw.toString("utf8")));
  require(JSON.stringify(record)+"\n" === data.raw.toString("utf8"), "record serialization");
  const actual = await inventory(prefix);
  for(const directory of [prefix,...actual.directories.map((p) => path.join(prefix,p))]) require(((await lstat(directory)).mode&0o777)===0o555, "unsealed retained directory");
  const expected = [...record.files,expectedRecordFileIdentity].sort((a,b) => a.path < b.path?-1:Number(a.path>b.path));
  require(JSON.stringify(actual.files.map((r) => ({...r,path:"python/"+r.path}))) === JSON.stringify(expected), "retained bytes/mode/undeclared payload");
  for (const absent of record.protectedAbsent) {
    try { await lstat(path.join(root,absent)); fail("declared absent input present"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  budget(expected,actual.directories.map((p) => "python/"+p));
  return record;
}

async function removeEmptyStageParent(parent) {
  try { await rmdir(parent); }
  catch(error) { if(!["ENOENT","ENOTEMPTY"].includes(error.code)) throw error; }
}

/** Fixed source selection and fixed probe; no candidate evaluator or launch permission. */
export async function retainQualifiedPython(root) {
  require(process.platform === "linux" && process.env.GITHUB_ACTIONS === "true", "Linux CI only");
  require(path.isAbsolute(root) && await realpath(root) === root, "canonical output root");
  const baseline=await inventory(root); budget(baseline.files,baseline.directories,true);
  const prefix = path.join(root,"python");
  try { await lstat(prefix); fail("destination already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const selected = await realpath("/usr/bin/python3");
  const interpreter = await bytes(selected,leafLimit,true);
  require(interpreter.raw.subarray(0,4).equals(Buffer.from([127,69,76,70])), "native interpreter ELF");
  const fixedProbe = path.join(here,"probe-qualified-python.py");
  const probeSource = await bytes(fixedProbe,65536);
  const source = await probe(selected,fixedProbe); observation(source,false);
  const abi = source.version.slice(0,2).join(".");
  require(source.executable === selected && source.stdlib === source.platstdlib && source.stdlib === `/usr/lib/python${abi}` && source.extensionDirectory === source.stdlib+"/lib-dynload", "unsupported source stdlib layout");
  const parent = await mkdtemp(path.join(path.dirname(root),".python-retention-"));
  const stage = path.join(parent,"python");
  const sourceFiles = [], absent = new Set([`python/lib/python${source.version[0]}${source.version[1]}.zip`,"python/pyvenv.cfg","python/bin/pyvenv.cfg"]);
  async function retain(sourcePath, member, rawData) {
    const data = rawData ?? await bytes(sourcePath,leafLimit,true);
    const mode = member === "python/bin/python3"?0o555:0o444;
    const destination = path.join(parent,member);
    await mkdir(path.dirname(destination),{recursive:true});
    await writeFile(destination,data.raw,{flag:"wx",mode});
    sourceFiles.push({sourcePath,path:member,sourceMode:data.mode,mode,size:data.raw.length,sha256:digest(data.raw)});
    require(sourceFiles.length < memberLimit && sourceFiles.reduce((n,r) => n+r.size,0) <= tarLimit, "copy bounds");
  }
  async function copyDirectory(directory, relativeName = "") {
    await protectedSource(directory);
    const directoryInfo=await lstat(directory);
    require(directoryInfo.isDirectory() && directoryInfo.uid===0 && !(directoryInfo.mode&0o022), "source directory protection");
    await mkdir(path.join(stage,"lib",`python${abi}`,relativeName),{recursive:true});
    for (const name of (await readdir(directory)).sort()) {
      const rel = relativeName?relativeName+"/"+name:name;
      if (excluded(rel)) { absent.add(`python/lib/python${abi}/`+rel); continue; }
      const file = path.join(directory,name), info = await lstat(file);
      if (info.isDirectory() && !info.isSymbolicLink()) await copyDirectory(file,rel);
      else {
        if (!info.isFile() || info.isSymbolicLink()) {
          const target = info.isSymbolicLink() ? (await readlink(file)).slice(0,4096) : null;
          fail("source symlink/special " + JSON.stringify({path:rel.slice(0,4096),target}));
        }
        await retain(file,`python/lib/python${abi}/`+rel);
      }
    }
  }
  try {
    await retain(selected,"python/bin/python3",interpreter);
    await copyDirectory(source.stdlib);
    await mkdir(path.join(stage,"provenance"));
    await writeFile(path.join(parent,probePath),probeSource.raw,{flag:"wx",mode:0o444});
    const copied = await inventory(stage);
    const copiedFiles = copied.files.map((r) => ({...r,path:"python/"+r.path}));
    const existing = await inventory(root);
    const sourceInputs = [];
    for (const name of ["retain-qualified-python.mjs","probe-qualified-python.py"]) {
      const raw = (await bytes(path.join(here,name),leafLimit)).raw;
      sourceInputs.push({path:`packages/server/scripts/${name}`,bytes:raw.length,sha256:digest(raw)});
    }
    for(const p of ["python/pyvenv.cfg","python/bin/pyvenv.cfg",`python/lib/python${source.version[0]}${source.version[1]}.zip`,"python/bin/python3._pth",`python/lib/python${abi}/site-packages`,`python/lib/python${abi}/dist-packages`]) absent.add(p);
    const record = {schemaVersion:1,kind:"retained-cpython-layout-v1",qualification:false,
      source:{requestedExecutable:"/usr/bin/python3",resolvedExecutable:selected,executableIdentity:{path:selected,mode:interpreter.mode,size:interpreter.raw.length,sha256:digest(interpreter.raw)},
        ...Object.fromEntries(["version","implementation","cacheTag","abiFlags","platlibdir","stdlib","platstdlib","extensionDirectory"].map((k) => [k,source[k]])),packageProvenance:await sourcePackages(sourceFiles.map((r) => r.sourcePath))},
      layout:{executable:"python/bin/python3",stdlib:`python/lib/python${abi}`,extensionDirectory:`python/lib/python${abi}/lib-dynload`,argvFlags:flags},
      sourceFiles:sourceFiles.sort((a,b) => a.path < b.path?-1:Number(a.path>b.path)),files:copiedFiles,protectedAbsent:Array.from(absent).sort(),observed:{source,relocated:null},
      budgets:budget([...existing.files,...copiedFiles],[...existing.directories,...copied.directories.map((p) => "python/"+p),"python"],true)};
    async function saveRecord(base) {
      const raw = Buffer.from(JSON.stringify(record)+"\n");
      require(raw.length <= recordLimit, "record byte bound");
      const file = path.join(base,recordPath);
      try { await chmod(file,0o600); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await writeFile(file,raw,{mode:0o444}); await chmod(file,0o444);
      return {path:recordPath,mode:0o444,size:raw.length,sha256:digest(raw)};
    }
    let recordFile = await saveRecord(parent);
    const initialTree=await inventory(stage);
    for(const p of [...initialTree.directories].sort((a,b) => b.length-a.length)) await chmod(path.join(stage,p),0o555);
    await chmod(stage,0o555);
    await assertRetainedQualifiedPython(parent,recordFile);
    try { await lstat(prefix); fail("destination appeared during capture"); } catch(error) { if(error.code!=="ENOENT") throw error; }
    await rename(stage,prefix);
    await assertRetainedQualifiedPython(root,recordFile);
    record.observed.relocated = normalizeProbe(await probe(path.join(root,record.layout.executable),path.join(root,probePath)),root);
    require(JSON.stringify(record.observed.relocated.version) === JSON.stringify(source.version), "relocated version");
    recordFile = await saveRecord(root);
    await assertRetainedQualifiedPython(root,recordFile);
    for (const row of sourceFiles) require(digest((await bytes(row.sourcePath,leafLimit,true)).raw) === row.sha256, "source changed after capture");
    require(await realpath("/usr/bin/python3")===selected, "source interpreter selection changed");
    const final = await inventory(prefix);
    for (const name of [...final.directories].sort((a,b) => b.length-a.length)) await chmod(path.join(prefix,name),0o555);
    await chmod(prefix,0o555);
    return {sourceInputs,files:[...record.files,recordFile].sort((a,b) => a.path < b.path?-1:Number(a.path>b.path)),record:recordFile};
  } finally {
    // Preserve failed sealed staging for CI diagnostics; no retry by deleting it.
    await removeEmptyStageParent(parent);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  require(process.argv.length === 3, "destination root only");
  console.log(JSON.stringify(await retainQualifiedPython(path.resolve(process.argv[2]))));
}
