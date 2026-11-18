import { constants } from "node:fs";
import { open, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const sourceDirectory = fileURLToPath(new URL("../src/server/execution/native/", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
function compile(args) {
  const result = spawnSync("/usr/bin/cc", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  if (result.status !== 0) throw new Error(`Finite Git native build failed: ${result.stderr}`);
  return result.stdout;
}
async function gitBytes() {
  const file = await realpath("/usr/bin/git");
  const descriptor = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await descriptor.stat({ bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.mode & 0o022n || before.size > 134217728n)
      throw new Error("Unsupported Git build input");
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    for (const key of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"])
      if (before[key] !== after[key]) throw new Error("Unstable Git build input");
    if (
      BigInt(bytes.length) !== before.size ||
      !bytes.subarray(0, 4).equals(Buffer.from("\x7fELF"))
    )
      throw new Error("Native Git ELF required");
    return bytes;
  } finally {
    await descriptor.close();
  }
}
function gitBuildProvenance() {
  const options = {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  };
  const version = spawnSync("/usr/bin/git", ["--version", "--build-options"], options);
  const source = spawnSync(
    "/usr/bin/dpkg-query",
    ["-W", "-f", "${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n", "git"],
    options,
  );
  if (version.status !== 0 || source.status !== 0)
    throw new Error("Git build/source provenance unavailable");
  return { buildOptions: version.stdout, sourcePackage: source.stdout };
}
/** Builds measured inputs only. No helper profile, launch permission or settlement grant. */
export async function buildQualifiedGit(root) {
  if (process.platform !== "linux") throw new Error("Linux finite Git only");
  const runtime = path.join(root, "runtime"),
    sources = path.join(root, "native-source");
  await mkdir(runtime, { recursive: true });
  await mkdir(sources, { recursive: true });
  const sourceInputs = [];
  for (const name of ["git-observer.c", "git-gate.c", "git-wire.h"]) {
    const bytes = await readFile(path.join(sourceDirectory, name));
    await writeFile(path.join(sources, name), bytes, { flag: "wx", mode: 0o444 });
    sourceInputs.push({
      path: `packages/server/src/server/execution/native/${name}`,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
  }
  const flags = [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fstack-protector-strong",
    "-Wl,-z,relro,-z,now",
  ];
  compile([
    ...flags,
    "-fPIE",
    "-pie",
    path.join(sources, "git-observer.c"),
    "-o",
    path.join(runtime, "git-observer"),
  ]);
  compile([
    ...flags,
    "-fPIC",
    "-shared",
    path.join(sources, "git-gate.c"),
    "-o",
    path.join(runtime, "git-gate.so"),
  ]);
  const bytes = await gitBytes();
  await writeFile(path.join(runtime, "git"), bytes, { flag: "wx", mode: 0o555 });
  return {
    sourceInputs,
    protocol: "finite-git-fd-gate-v1",
    compiler: {
      sha256: hash(await readFile(await realpath("/usr/bin/cc"))),
      version: compile(["--version"]),
      flags,
    },
    git: { sha256: hash(bytes), size: bytes.length, ...gitBuildProvenance() },
  };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.length !== 3) throw new Error("fixed output root required");
  console.log(JSON.stringify(await buildQualifiedGit(path.resolve(process.argv[2]))));
}
