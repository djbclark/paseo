import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, lstat, readdir, readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
const execute = promisify(execFile);
const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const digest = (raw) => createHash("sha256").update(raw).digest("hex");
async function identity(file, maximum = 536870912n) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > maximum)
      throw new Error("Unstable/nonregular build evidence leaf");
    const hash = createHash("sha256");
    let total = 0n;
    for (;;) {
      const block = Buffer.alloc(1048576);
      const read = await handle.read(block);
      if (!read.bytesRead) break;
      total += BigInt(read.bytesRead);
      if (total > before.size) throw new Error("Build leaf changed");
      hash.update(block.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"])
      if (before[key] !== after[key] || before[key] !== current[key])
        throw new Error("Build leaf changed");
    if (total !== before.size) throw new Error("Build leaf shortened");
    return { bytes: Number(total), mode: Number(before.mode & 0o777n), sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}
async function inventory(root) {
  const files = [];
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) await visit(file);
      else {
        if (!stat.isFile()) throw new Error("Special build evidence leaf");
        files.push(path.relative(root, file));
      }
    }
  }
  await visit(root);
  return files.sort();
}
async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux")
    throw new Error("Build evidence archive is Linux CI only");
  const [requestedRoot, requestedOutput] = process.argv.slice(2);
  if (!requestedRoot || !requestedOutput)
    throw new Error("Distribution and archive directories required");
  const root = await realpath(requestedRoot);
  const output = path.resolve(requestedOutput);
  const manifestRaw = await readFile(`${root}.manifest.json`);
  const manifest = JSON.parse(manifestRaw);
  const inputsRaw = await readFile(path.join(root, "inputs.json"));
  const inputs = JSON.parse(inputsRaw);
  if (inputsRaw.includes(Buffer.from(repository)))
    throw new Error("Absolute source path in build inputs");
  if (manifest.schemaVersion !== 2 || manifest.profile !== "enclosing-daemon-v2")
    throw new Error("Unknown build evidence profile");
  if (
    JSON.stringify(await inventory(root)) !==
    JSON.stringify(manifest.files.map((row) => row.path).sort())
  )
    throw new Error("Build evidence inventory changed");
  for (const row of manifest.files) {
    const actual = await identity(path.join(root, row.path));
    if (actual.bytes !== row.size || actual.mode !== row.mode || actual.sha256 !== row.sha256)
      throw new Error("Build evidence bytes differ from final manifest");
  }
  const environment = { PATH: process.env.PATH };
  const source = (
    await execute("git", ["-C", repository, "rev-parse", "HEAD"], {
      env: environment,
      timeout: 10000,
    })
  ).stdout.trim();
  if (source !== process.env.GITHUB_SHA || !/^[0-9a-f]{40}$/.test(source))
    throw new Error("Checkout differs from build run source");
  const scripts = {};
  for (const name of [
    "build-qualified-daemon.mjs",
    "build-qualified-git.mjs",
    "qualified-git.test.mjs",
    "qualified-builtin-sources.mjs",
    "build-qualified-builtins.mjs",
    "retain-system-closure.mjs",
    "qualified-system-namespace.py",
    "finalize-qualified-daemon.mjs",
    "archive-qualified-daemon.mjs",
  ])
    scripts[`packages/server/scripts/${name}`] = await identity(
      path.join(repository, "packages/server/scripts", name),
    );
  const evidence = {
    schemaVersion: 1,
    kind: "paseo-daemon-build-input-evidence",
    qualification: false,
    source: {
      commit: source,
      packageLockSha256: inputs.packageLockSha256,
      inputsSha256: digest(inputsRaw),
      scripts,
    },
    build: {
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      workflow: process.env.GITHUB_WORKFLOW,
    },
    toolchain: {
      ...inputs.toolchain,
      npm: (
        await execute("npm", ["--version"], { env: environment, timeout: 10000 })
      ).stdout.trim(),
      executingNode: await identity(await realpath(process.execPath)),
    },
    distributionBuildId: manifest.distributionBuildId,
    manifestSha256: digest(manifestRaw),
    runtime: manifest.runtime,
    esbuild: manifest.esbuild,
    helperClosureSha256: manifest.helperClosureSha256,
    nativeLibraries: manifest.externalLibraries,
  };
  const name = path.basename(root);
  const evidencePath = `${root}.build-evidence.json`;
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o444 });
  await mkdir(output, { recursive: true });
  const archive = path.join(output, "qualified-daemon-build.tar");
  await execute(
    "tar",
    [
      "--format=posix",
      "--sort=name",
      "--numeric-owner",
      "--pax-option=delete=atime,delete=ctime",
      "-cf",
      archive,
      "-C",
      path.dirname(root),
      name,
      `${name}.manifest.json`,
      `${name}.build-evidence.json`,
    ],
    { env: environment, timeout: 600000 },
  );
  const archiveDigest = (await identity(archive, 4294967296n)).sha256;
  await writeFile(
    path.join(output, "SHA256SUMS"),
    `${archiveDigest}  qualified-daemon-build.tar\n`,
  );
  process.stdout.write(
    JSON.stringify({
      kind: evidence.kind,
      source: source,
      manifestSha256: evidence.manifestSha256,
      archiveSha256: archiveDigest,
      qualification: false,
    }) + "\n",
  );
}
await main();
