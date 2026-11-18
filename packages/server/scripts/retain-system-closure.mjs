import { constants } from "node:fs";
import {
  open,
  lstat,
  realpath,
  readdir,
  readlink,
  mkdir,
  writeFile,
  chmod,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeElf,
  describeLoaderCache,
  isTargetElf,
} from "../dist/server/server/execution/elf-format.js";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const order = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const absent = async (file) => {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
};
async function snapshot(file, limit = 512 * 1024 * 1024, prefixOnly = false) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit))
      throw new Error("Invalid system closure source");
    const prefix = Buffer.alloc(64);
    const { bytesRead } = await handle.read(prefix, 0, 64, 0);
    const machine = process.arch === "x64" ? 62 : 183;
    const bytes =
      prefixOnly && !isTargetElf(prefix.subarray(0, bytesRead), machine)
        ? null
        : await handle.readFile();
    const after = await handle.stat({ bigint: true });
    for (const key of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"])
      if (before[key] !== after[key]) throw new Error("Unstable system closure source");
    if (bytes && BigInt(bytes.length) !== before.size)
      throw new Error("Short system closure source");
    return { bytes, stat: before };
  } finally {
    await handle.close();
  }
}
async function protectedSource(file) {
  if ((await realpath(file)) !== file) throw new Error("Noncanonical system closure source");
  for (let current = file; ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (stat.uid !== 0 || stat.mode & 0o022 || stat.isSymbolicLink())
      throw new Error("Writable system closure source");
    if (current === path.dirname(current)) break;
  }
}
function buildOwnedPath(retained, current, root) {
  return (
    retained &&
    (current === root || current.startsWith(`${root}/`) || root.startsWith(`${current}/`))
  );
}
export async function retainSystemClosure(root) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Linux system closure only");
  if (!(await absent(path.join(root, "system-closure"))))
    throw new Error("System closure output already exists");
  if (!(await absent("/etc/ld.so.preload"))) throw new Error("Preload policy unsupported");
  const machine = process.arch === "x64" ? 62 : 183;
  const elfs = new Map(),
    external = new Map(),
    aliases = new Map(),
    directories = new Map(),
    interpreters = new Map();
  const needed = new Set(),
    pending = [],
    cacheRows = new Map();
  let total = 0;
  function directory(kind, name) {
    directories.set(`${kind}:${name}`, { kind, path: name });
    if (directories.size > 64) throw new Error("System search bound");
  }
  const activeLinks = new Set();
  async function links(file) {
    const retained = file === root || file.startsWith(`${root}/`);
    let current = "/",
      sawLink = false;
    for (const component of file.split("/").filter(Boolean)) {
      if (component === ".") continue;
      if (component === "..") {
        if (sawLink || (retained && current === root))
          throw new Error("Unsupported symlink/parent loader traversal");
        current = path.dirname(current);
        continue;
      }
      current = path.join(current, component);
      const stat = await lstat(current);
      if (!stat.isSymbolicLink()) {
        const buildOwned = buildOwnedPath(retained, current, root);
        if (!buildOwned && (stat.uid !== 0 || stat.mode & 0o022))
          throw new Error("Mutable loader traversal");
        continue;
      }
      if (stat.uid !== 0 || activeLinks.has(current) || activeLinks.size >= 32)
        throw new Error("Unprotected/cyclic system alias");
      activeLinks.add(current);
      sawLink = true;
      const target = await realpath(current),
        linkText = await readlink(current);
      const row = { path: current, target, linkText },
        old = aliases.get(current);
      if (old && JSON.stringify(old) !== JSON.stringify(row))
        throw new Error("Changing system alias");
      aliases.set(current, row);
      if (aliases.size > 512) throw new Error("System alias bound");
      const parent = await realpath(path.dirname(current));
      await links(linkText.startsWith("/") ? linkText : `${parent}/${linkText}`);
      activeLinks.delete(current);
      if ((await lstat(target)).isDirectory()) directory("system", target);
    }
  }
  let selectionEntries = 0;
  async function selectionTree(base, depth = 0) {
    if (await absent(base)) return;
    if (depth > 8 || selectionEntries++ > 4096) throw new Error("Loader selection traversal bound");
    await links(base);
    const stat = await lstat(base);
    if (!stat.isDirectory() && !stat.isSymbolicLink())
      throw new Error("Invalid loader selection directory");
    const canonical = await realpath(base);
    if (!(await lstat(canonical)).isDirectory()) throw new Error("Invalid loader selection target");
    for (const name of await readdir(base)) {
      if (needed.has(name)) throw new Error("Relevant hwcaps/tls selection unsupported");
      const child = `${base}/${name}`;
      await links(child);
      const info = await lstat(child);
      if (info.isDirectory() || info.isSymbolicLink()) await selectionTree(child, depth + 1);
    }
  }
  async function capture(original, recordLinks = true) {
    if (recordLinks) await links(original);
    const target = await realpath(original);
    if (target.startsWith(`${root}/`)) return target;
    if (external.has(target)) return target;
    await protectedSource(target);
    const { bytes } = await snapshot(target);
    if (!bytes || !isTargetElf(bytes, machine))
      throw new Error("External dependency ABI unsupported");
    total += bytes.length;
    if (total > 512 * 1024 * 1024 || external.size >= 128) throw new Error("System payload bound");
    const retainedPath = `system-closure/elf/${target.slice(1)}`;
    const destination = path.join(root, retainedPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
    const copied = await snapshot(destination);
    if (!copied.bytes || !copied.bytes.equals(bytes))
      throw new Error("System payload copy mismatch");
    const identity = {
      path: target,
      retainedPath,
      mode: 0o444,
      size: bytes.length,
      sha256: digest(bytes),
    };
    external.set(target, identity);
    pending.push({ file: destination, member: retainedPath, bytes, runtimePath: target });
    directory("system", path.dirname(target));
    return target;
  }
  async function collectSearchDirectories(row, description) {
    for (const token of [...description.rpath, ...description.runpath]) {
      const origin = path.dirname(row.runtimePath ?? row.file);
      const expanded = token.replaceAll("${ORIGIN}", origin).replaceAll("$ORIGIN", origin);
      if (expanded.includes("$") || !path.isAbsolute(expanded))
        throw new Error("Unknown ELF search token");
      await links(expanded);
      const resolved = await realpath(expanded);
      if (await absent(resolved))
        throw new Error(`Absent declared ELF search directory: ${row.member} ${token}`);
      if (!(await lstat(resolved)).isDirectory()) throw new Error("Invalid ELF search directory");
      if (resolved === root) throw new Error("Artifact root ELF search unsupported");
      if (resolved.startsWith(`${root}/`))
        directory("retained", path.relative(root, resolved) || ".");
      else {
        await links(resolved);
        directory("system", await realpath(resolved));
      }
    }
  }
  async function discover(row) {
    let description;
    try {
      description = describeElf(row.bytes);
    } catch (error) {
      const diagnostic = spawnSync(
        "/usr/bin/readelf",
        ["--dynamic", "--wide", "--program-headers", row.file],
        {
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 32768,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        },
      );
      throw new Error(
        `ELF inventory refused member ${row.member} sha256=${digest(row.bytes)} size=${row.bytes.length}\n${diagnostic.stdout ?? "Dynamic metadata unavailable"}`,
        { cause: error },
      );
    }
    elfs.set(row.member, { member: row.member, ...description });
    if (elfs.size > 512) throw new Error("System ELF bound");
    for (const name of description.needed) {
      if (name.includes("/") || name.includes("\0")) throw new Error("Unsupported needed path");
      needed.add(name);
    }
    if (description.interpreter) {
      const target = await capture(description.interpreter);
      interpreters.set(description.interpreter, { request: description.interpreter, target });
      const identity = external.get(target);
      if (!identity) throw new Error("Interpreter mapping unavailable");
      identity.mode = 0o555;
      await chmod(path.join(root, identity.retainedPath), 0o555);
    }
    await collectSearchDirectories(row, description);
    const result = spawnSync("/usr/bin/ldd", [row.file], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin" },
    });
    if (result.status !== 0) {
      if (description.needed.length || description.interpreter)
        throw new Error(`Unresolved ELF dependencies: ${row.member}`);
      return;
    }
    for (const line of result.stdout.split("\n")) {
      if (line.includes("not found")) throw new Error(`Missing ELF dependency: ${row.member}`);
      const match = line.match(/(?:=>\s+|^\s*)(\/[^ ]+)/);
      if (match) await capture(match[1], false);
    }
  }
  async function visit(directoryPath) {
    for (const name of (await readdir(directoryPath)).sort()) {
      const file = path.join(directoryPath, name),
        stat = await lstat(file);
      if (stat.isDirectory()) {
        await visit(file);
        continue;
      }
      if (!stat.isFile()) throw new Error("Special retained closure member");
      const { bytes } = await snapshot(file, 512 * 1024 * 1024, true);
      if (bytes) pending.push({ file, member: path.relative(root, file), bytes });
    }
  }
  await visit(root);
  await protectedSource("/etc/ld.so.cache");
  const cached = await snapshot("/etc/ld.so.cache", 16 * 1024 * 1024);
  const cacheEntries = describeLoaderCache(cached.bytes, machine);
  let processed = 0,
    previous = -1;
  while (processed < pending.length || previous !== needed.size) {
    while (processed < pending.length) await discover(pending[processed++]);
    previous = needed.size;
    for (const row of cacheEntries.filter((entry) => needed.has(entry.soname))) {
      if (row.hwcap !== "0") throw new Error(`Relevant hwcap unsupported: ${row.soname}`);
      const target = await capture(row.path);
      cacheRows.set(`${row.soname}:${row.path}:${row.flags}`, { ...row, target });
      if (cacheRows.size > 2048) throw new Error("Relevant cache entry bound");
    }
  }
  async function completeSearchInventory() {
    const defaults =
      process.arch === "x64"
        ? ["/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib", "/usr/lib"]
        : ["/lib/aarch64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib", "/usr/lib"];
    for (const value of defaults) {
      await links(value);
      if (await absent(value)) throw new Error("Missing default search directory");
      directory("system", await realpath(value));
    }
    // Every reachable lookup for a known needed name must select an inventoried object.
    for (const row of directories.values()) {
      const base = row.kind === "system" ? row.path : path.resolve(root, row.path);
      for (const name of needed) {
        const candidate = path.join(base, name);
        if (await absent(candidate)) continue;
        const target = await realpath(candidate);
        if (!external.has(target) && !elfs.has(path.relative(root, target)))
          throw new Error(`Unretained search selection: ${candidate}`);
        if (row.kind === "system") await links(candidate);
      }
      await selectionTree(path.join(base, "glibc-hwcaps"));
      await selectionTree(path.join(base, "tls"));
    }
  }
  await completeSearchInventory();
  const finalCacheEntries = [];
  for (const row of cacheEntries.filter((entry) => needed.has(entry.soname))) {
    finalCacheEntries.push({ ...row, target: await realpath(row.path) });
    if (finalCacheEntries.length > 2048) throw new Error("Relevant cache entry bound");
  }
  const retainedPath = "system-closure/loader/ld.so.cache";
  await mkdir(path.dirname(path.join(root, retainedPath)), { recursive: true });
  await writeFile(path.join(root, retainedPath), cached.bytes, { flag: "wx", mode: 0o444 });
  const bootstrapSource = fileURLToPath(new URL("qualified-system-namespace.py", import.meta.url));
  const bootstrap = await snapshot(bootstrapSource, 1024 * 1024);
  const bootstrapTarget = path.join(root, "system-closure/namespace-bootstrap.py");
  await writeFile(bootstrapTarget, bootstrap.bytes, { flag: "wx", mode: 0o444 });
  const loaderResolution = {
    schemaVersion: 1,
    policy: "glibc-pinned-cache-existing-layout-v1",
    elf: [...elfs.values()].sort((a, b) => order(a.member, b.member)),
    interpreters: [...interpreters.values()].sort((a, b) => order(a.request, b.request)),
    aliases: [...aliases.values()].sort((a, b) => order(a.path, b.path)),
    searchDirectories: [...directories.values()].sort((a, b) =>
      order(`${a.kind}:${a.path}`, `${b.kind}:${b.path}`),
    ),
    hwcaps: { policy: "no-relevant-hwcaps-v1" },
    cache: {
      path: "/etc/ld.so.cache",
      retainedPath,
      mode: 0o444,
      size: cached.bytes.length,
      sha256: digest(cached.bytes),
      entries: finalCacheEntries.sort((a, b) =>
        order(`${a.soname}:${a.path}:${a.flags}`, `${b.soname}:${b.path}:${b.flags}`),
      ),
    },
    preload: { path: "/etc/ld.so.preload", state: "absent" },
  };
  return {
    externalLibraries: [...external.values()].sort((a, b) => order(a.path, b.path)),
    systemClosure: {
      schemaVersion: 1,
      profile: "linux-retained-system-closure-v1",
      loaderResolution,
    },
  };
}
