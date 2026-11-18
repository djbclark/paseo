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
