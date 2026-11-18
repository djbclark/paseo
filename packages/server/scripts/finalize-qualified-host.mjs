import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  rm,
  mkdir,
  readdir,
  lstat,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
const sha = (value) => createHash("sha256").update(value).digest("hex");
export async function finalizeQualifiedHost(root, runtimePath) {
  const canonical = await realpath(root);
  const inputs = JSON.parse(await readFile(path.join(canonical, "inputs.json"), "utf8"));
  await mkdir(path.join(canonical, "runtime"), { recursive: true });
  await rm(path.join(canonical, "runtime/node"), { force: true });
  await cp(runtimePath, path.join(canonical, "runtime/node"));
  const describe = async (file, name = file) => {
    await chmod(file, name === "runtime/node" ? 0o555 : 0o444);
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error("Nonregular closure member");
    return {
      path: name,
      sha256: sha(await readFile(file)),
      size: stat.size,
      mode: stat.mode & 0o777,
    };
  };
  const files = [];
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) {
        await visit(file);
        await chmod(file, 0o555);
      } else files.push(await describe(file, path.relative(canonical, file)));
    }
  }
  await visit(canonical);
  await chmod(canonical, 0o555);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const observation = spawnSync(
    path.join(canonical, "runtime/node"),
    [
      "-e",
      `const fs=require('node:fs'); require('node:os').userInfo(); process.stdout.write(JSON.stringify([...new Set(fs.readFileSync('/proc/self/maps','utf8').split('\\n').flatMap(line=>{const m=line.match(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +(\\/.*)$/);return m?[fs.realpathSync(m[1])]:[]}))].sort())));`,
    ],
    { encoding: "utf8", timeout: 10000, env: { PATH: "/usr/bin:/bin" } },
  );
  if (observation.status !== 0)
    throw new Error(`Runtime inventory unavailable: ${observation.stderr}`);
  const describeExternal = async (file) => {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error("Nonregular runtime library");
    return {
      path: file,
      sha256: sha(await readFile(file)),
      size: stat.size,
      mode: stat.mode & 0o777,
    };
  };
  const externalLibraries = [];
  for (const file of JSON.parse(observation.stdout))
    if (file !== path.join(canonical, "runtime/node"))
      externalLibraries.push(await describeExternal(file));
  const manifest = {
    schemaVersion: 1,
    role: "plugin-host",
    distributionBuildId: inputs.distributionBuildId,
    roleBuildId: inputs.roleBuildId,
    files,
    runtime: files.find((file) => file.path === "runtime/node"),
    externalLibraries,
    helpers: [],
    bindingKeys: [
      "@getpaseo/plugin",
      "@getpaseo/plugin/server",
      "@getpaseo/plugin/server/provider",
      "@getpaseo/plugin/server/acp",
      "@getpaseo/plugin/server/usage",
      "@getpaseo/client",
      "@getpaseo/client/internal/daemon-client",
      "@getpaseo/protocol/binary-frames/index",
      "zod",
    ].sort(),
  };
  const raw = JSON.stringify(manifest);
  await writeFile(`${canonical}.manifest.json`, raw);
  return {
    immutabilityAdapter: "linux-root-owned-retained-v1",
    immutableRoot: canonical,
    manifestSha256: sha(raw),
    distributionBuildId: inputs.distributionBuildId,
    roleBuildId: inputs.roleBuildId,
  };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [root, runtime] = process.argv.slice(2);
  if (!root || !runtime) throw new Error("root and runtime required");
  process.stdout.write(JSON.stringify(await finalizeQualifiedHost(root, runtime)) + "\n");
}
