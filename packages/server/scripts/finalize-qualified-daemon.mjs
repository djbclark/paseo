import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  readdir,
  lstat,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function identity(file, name = file) {
  const stat = await lstat(file);
  if (!stat.isFile()) throw new Error("Nonregular daemon closure member");
  return {
    path: name,
    mode: stat.mode & 0o777,
    size: stat.size,
    sha256: digest(await readFile(file)),
  };
}
export async function finalizeQualifiedDaemon(root, runtime, qualificationSha256) {
  if (
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch) ||
    !/^[a-f0-9]{64}$/.test(qualificationSha256)
  )
    throw new Error("Linux qualification recipe digest required");
  root = await realpath(root);
  const inputs = JSON.parse(await readFile(path.join(root, "inputs.json"), "utf8"));
  await mkdir(path.join(root, "runtime"), { recursive: true });
  const esbuild = path.join(root, "node_modules", `@esbuild/linux-${process.arch}/bin/esbuild`);
  for (const [source, target] of [
    [runtime, "node"],
    [esbuild, "esbuild"],
  ]) {
    const destination = path.join(root, "runtime", target);
    await rm(destination, { force: true });
    await cp(source, destination);
    await chmod(destination, 0o555);
  }
  const files = [];
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) {
        await visit(file);
        await chmod(file, 0o555);
      } else {
        if (!stat.isFile()) throw new Error("Symlink/special daemon closure member");
        await chmod(file, stat.mode & 0o111 ? 0o555 : 0o444);
        files.push(await identity(file, path.relative(root, file)));
      }
    }
  }
  await visit(root);
  await chmod(root, 0o555);
  files.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  const libraries = new Set();
  for (const file of files.filter(
    (row) => row.path === "runtime/node" || row.path.endsWith(".node"),
  )) {
    const header = await readFile(path.join(root, file.path));
    // Only this target's ELF addons can be loaded by the retained Linux Node.
    if (
      file.path.endsWith(".node") &&
      (header.length < 20 ||
        header.readUInt32BE(0) !== 0x7f454c46 ||
        header[5] !== 1 ||
        header.readUInt16LE(18) !==
          (process.arch === "x64" ? 62 : process.arch === "arm64" ? 183 : -1))
    )
      continue;
    const result = spawnSync("ldd", [path.join(root, file.path)], {
      encoding: "utf8",
      timeout: 10000,
      env: { PATH: "/usr/bin:/bin" },
    });
    if (result.status !== 0) throw new Error("Native library inventory unavailable");
    for (const line of result.stdout.split("\n")) {
      if (line.includes("not found")) throw new Error("Native library unresolved");
      const match = line.match(/(?:=>\s+|^\s*)(\/[^ ]+)/);
      if (match) libraries.add(await realpath(match[1]));
    }
  }
  const externalLibraries = [];
  for (const file of [...libraries].sort())
    if (!file.startsWith(`${root}/`)) externalLibraries.push(await identity(file));
  const helperInventory = [
    ...files.filter(
      (file) =>
        file.path.startsWith("runtime/") ||
        /(?:compiler|terminal)-(?:entry|code)\.mjs$/.test(file.path) ||
        file.path.endsWith(".node") ||
        file.path.endsWith("spawn-helper") ||
        file.path.startsWith("node_modules/esbuild/") ||
        file.path === "node_modules/typescript/lib/typescript.js",
    ),
    ...externalLibraries,
  ].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  const manifest = {
    schemaVersion: 2,
    profile: "enclosing-daemon-v2",
    distributionBuildId: inputs.distributionBuildId,
    files,
    runtime: files.find((file) => file.path === "runtime/node"),
    esbuild: files.find((file) => file.path === "runtime/esbuild"),
    externalLibraries,
    helperInventory,
    helperClosureSha256: digest(JSON.stringify(helperInventory)),
    entries: {
      daemon: "daemon.mjs",
      pluginChild: "plugin-child-entry.mjs",
      compiler: "compiler-entry.mjs",
      terminal: "terminal-entry.mjs",
    },
    bindingKeys: [
      "@getpaseo/plugin/internal/activity",
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
  await writeFile(`${root}.manifest.json`, raw);
  return {
    immutabilityAdapter: "linux-root-owned-retained-v1",
    immutableRoot: root,
    distributionBuildId: inputs.distributionBuildId,
    manifestSha256: digest(raw),
    qualificationSha256,
  };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [root, runtime, qualification] = process.argv.slice(2);
  process.stdout.write(
    JSON.stringify(await finalizeQualifiedDaemon(root, runtime, qualification)) + "\n",
  );
}
