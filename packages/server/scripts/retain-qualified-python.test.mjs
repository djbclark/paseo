// Actual Linux CI copies/imports; corruption cases use the DATA verifier only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, unlink, symlink, link, lstat, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { retainQualifiedPython, assertRetainedQualifiedPython } from "./retain-qualified-python.mjs";

const execute=promisify(execFile);
const sha=(raw)=>createHash("sha256").update(raw).digest("hex");
const limits={zip:128*1024*1024,tar:512*1024*1024,members:10000};
async function unlinkIfPresent(file) {
  try { await unlink(file); } catch(error) { if(error.code!=="ENOENT") throw error; }
}
async function overwrite(file,raw) {
  await chmod(file,0o644); await writeFile(file,raw); await chmod(file,0o444);
}
async function changeDirectory(directory,operation) {
  await chmod(directory,0o755);
  try { return await operation(); } finally { await chmod(directory,0o555); }
}
test("fixed source retention, relocation and strict preexec DATA refusals",{timeout:240000},async(t)=>{
  assert.equal(process.platform,"linux");
  assert.equal(process.env.GITHUB_ACTIONS,"true");
  const parent=await mkdtemp(path.join(os.tmpdir(),"python-retention-ci-"));
  const root=path.join(parent,"distribution"); await mkdir(root);
  const retained=await retainQualifiedPython(root);
  const record=await assertRetainedQualifiedPython(root,retained.record);
  const recordFile=path.join(root,retained.record.path);
  const recordRaw=await readFile(recordFile);
  assert.equal(record.qualification,false);
  assert.deepEqual(Object.keys(retained).sort(),["files","record","sourceInputs"]);
  assert.equal(retained.files.filter((r)=>r.path===retained.record.path).length,1);
  assert.ok(!record.files.some((r)=>r.path===retained.record.path));
  assert.equal(record.source.requestedExecutable,"/usr/bin/python3");
  assert.ok(record.source.packageProvenance.length);
  assert.deepEqual(record.layout.argvFlags,["-I","-S","-B"]);
  assert.equal(record.observed.relocated.prefix,"python");
  assert.ok(record.observed.relocated.path.every((p)=>p.startsWith("python/")));
  assert.ok(record.observed.relocated.modules.some((r)=>r.name==="encodings" && r.origin.startsWith("python/")));
  assert.ok(record.observed.relocated.modules.some((r)=>r.name==="_ctypes" && r.origin.startsWith(record.layout.extensionDirectory+"/")));
  assert.ok(record.observed.relocated.modules.some((r)=>r.origin==="built-in"));
  assert.ok(record.observed.relocated.modules.some((r)=>r.origin==="frozen"));
  assert.ok(record.observed.relocated.nativeMapFiles.some((p)=>p.startsWith("/usr/")),"external mapped ELF remains explicit future closure input");
  const interpreter=record.sourceFiles.find((r)=>r.path==="python/bin/python3");
  assert.equal(interpreter.mode,0o555);
  assert.ok(interpreter.sourceMode&0o200,"actual source write bit is not normalized as retained mode");
  assert.ok(record.files.every((r)=>!r.path.endsWith(".pyc") && !r.path.endsWith(".pyo") && !r.path.includes("/__pycache__/")));
  assert.equal((await lstat(path.join(root,"python"))).mode&0o777,0o555);
  await t.test("existing destination refuses without replacing paid bytes",async()=>{
    await assert.rejects(retainQualifiedPython(root),/destination already exists/);
    assert.deepEqual(await readFile(recordFile),recordRaw);
  });
  for(const name of ["python/bin/python3",record.layout.stdlib+"/os.py",record.layout.stdlib+"/encodings/__init__.py",
    record.files.find((r)=>r.path.startsWith(record.layout.extensionDirectory+"/") && path.basename(r.path).startsWith("_ctypes.")).path]) {
    await t.test("corrupt bytes refuse without executing suspect code: "+name,async()=>{
      const file=path.join(root,name),original=await readFile(file),info=await lstat(file);
      const corrupt=Buffer.from(original);corrupt[0]^=1;
      try { await chmod(file,0o644); await writeFile(file,corrupt); await chmod(file,info.mode&0o777);
        await assert.rejects(assertRetainedQualifiedPython(root,retained.record),/retained bytes/);
      } finally { await chmod(file,0o644); await writeFile(file,original); await chmod(file,info.mode&0o777); }
    });
  }
  for(const kind of ["missing","symlink","hardlink","mode","undeclared","absent","unsealed-directory"]) {
    await t.test("closed payload refuses "+kind,async()=>{
      const file=path.join(root,record.layout.stdlib,"os.py"),directory=path.dirname(file),original=await readFile(file);
      const extra=path.join(directory,"retention-extra.py");
      try {
        if(kind==="missing") await changeDirectory(directory,()=>unlink(file));
        if(kind==="symlink") await changeDirectory(directory,async()=>{await unlink(file);await symlink("/usr/lib/"+path.basename(record.layout.stdlib)+"/os.py",file);});
        if(kind==="hardlink") await changeDirectory(directory,()=>link(file,extra));
        if(kind==="mode") await chmod(file,0o644);
        if(kind==="undeclared") await changeDirectory(directory,()=>writeFile(extra,"unknown\n",{mode:0o444}));
        if(kind==="absent") await changeDirectory(path.join(root,"python"),()=>writeFile(path.join(root,"python/pyvenv.cfg"),"home=/usr\n",{mode:0o444}));
        if(kind==="unsealed-directory") await chmod(directory,0o755);
        await assert.rejects(assertRetainedQualifiedPython(root,retained.record));
      } finally {
        await chmod(directory,0o755);
        for(const p of [file,extra]) await unlinkIfPresent(p);
        await writeFile(file,original,{mode:0o444}); await chmod(directory,0o555);
        if(kind==="absent") await changeDirectory(path.join(root,"python"),()=>unlink(path.join(root,"python/pyvenv.cfg")));
      }
    });
  }
  for(const kind of ["raw-hash","unknown","duplicate","order","escape","source-mode","source-map","missing-source","layout","flags","prefix","host-module","budgets","bytecode"]) {
    await t.test("strict record refuses "+kind,async()=>{
      const mutated=structuredClone(record);
      if(kind==="unknown")mutated.authorized=true;
      if(kind==="duplicate")mutated.files.push(mutated.files[0]);
      if(kind==="order")mutated.files.reverse();
      if(kind==="escape")mutated.files[0].path="../outside";
      if(kind==="source-mode")mutated.sourceFiles[0].sourceMode=0o777;
      if(kind==="source-map")mutated.sourceFiles[0].sourcePath="/tmp/source";
      if(kind==="missing-source")mutated.sourceFiles.pop();
      if(kind==="layout")mutated.layout.executable="/usr/bin/python3";
      if(kind==="flags")mutated.layout.argvFlags=["-S"];
      if(kind==="prefix")mutated.observed.relocated.prefix="/usr";
      if(kind==="host-module")mutated.observed.relocated.modules.find((r)=>r.name==="encodings").origin="/usr/lib/python3/encodings/__init__.py";
      if(kind==="budgets")mutated.budgets.tarLimit++;
      if(kind==="bytecode")mutated.files[0].path+=".pyc";
      const raw=Buffer.from(JSON.stringify(mutated)+"\n");
      try {
        await overwrite(recordFile,raw);
        const expectation=kind==="raw-hash"?retained.record:{path:retained.record.path,mode:0o444,size:raw.length,sha256:sha(raw)};
        await assert.rejects(assertRetainedQualifiedPython(root,expectation));
      } finally {await overwrite(recordFile,recordRaw);}
    });
  }
  await t.test("expected record path cannot select an arbitrary manifest",async()=>{
    await assert.rejects(assertRetainedQualifiedPython(root,{...retained.record,path:"other.json"}),/fixed record/);
  });
  await t.test("standalone actual TAR+ZIP budgets, not combined producer acceptance",async()=>{
    const archive=path.join(parent,"python.tar");
    await execute("/usr/bin/tar",["--format=posix","--sort=name","--numeric-owner","--pax-option=delete=atime,delete=ctime","-cf",archive,"-C",root,"python"],{timeout:60000});
    assert.ok((await lstat(archive)).size<=limits.tar);
    // Trusted fixed test code only; uses source Python for archive DATA, no code
    // from an artifact and no interpreter/env override to production helper.
    const script=path.join(parent,"archive-data.py");
    await writeFile(script,"import sys,zipfile,tarfile\np=sys.argv[1]\nwith tarfile.open(p) as t:\n assert len(t.getmembers())<=10000\nwith zipfile.ZipFile(p+'.zip','x',zipfile.ZIP_DEFLATED) as z:\n z.write(p,'python.tar')\n",{mode:0o444});
    await execute("/usr/bin/python3",["-I","-S","-B",script,archive],{timeout:60000,env:{PATH:"/usr/bin:/bin",LC_ALL:"C"}});
    assert.ok((await lstat(archive+".zip")).size<=limits.zip);
    console.log(JSON.stringify({kind:"retained-python-CI-DATA",qualification:false,version:record.source.version,
      recordSha256:retained.record.sha256,files:retained.files.length,tarBytes:(await lstat(archive)).size,zipBytes:(await lstat(archive+".zip")).size,
      combinedProducerFit:false}));
  });
  await assertRetainedQualifiedPython(root,retained.record);
});

test("complete output budget rejects oversize existing input before Python capture",{timeout:30000},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"python-retention-bound-"));
  const fd=await open(path.join(root,"oversize"),"wx",0o444);
  await fd.truncate(512*1024*1024+1);await fd.close();
  await assert.rejects(retainQualifiedPython(root),/unsafe regular input/);
});
