import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";

/** Fixed controller authority, independent of PASEO_HOME/HOME and caller arguments. */
export async function readFixedManagedPluginPolicy(): Promise<{ path: string; document: unknown }> {
  const account = userInfo();
  const home = await realpath(account.homedir);
  const file = path.join(home, ".local/state/djbclark-ade/forks/paseo-managed-plugins.json");
  for (let current = file; ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (stat.uid !== account.uid && stat.uid !== 0) || stat.mode & 0o022)
      throw new Error("Protected managed policy unavailable");
    if (current !== file && !stat.isDirectory())
      throw new Error("Protected managed policy ancestry unavailable");
    if (current === home) break;
    if (current === path.dirname(current))
      throw new Error("Managed policy outside real account home");
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(account.uid) ||
      before.nlink !== 1n ||
      before.mode & 0o077n ||
      before.size > 65536n
    )
      throw new Error("Managed policy must be account-owned private regular authority");
    const buffer = Buffer.alloc(65537);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 65536) throw new Error("Managed policy too large");
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    for (const key of [
      "dev",
      "ino",
      "uid",
      "gid",
      "nlink",
      "mode",
      "size",
      "mtimeNs",
      "ctimeNs",
    ] as const)
      if (before[key] !== after[key] || before[key] !== current[key])
        throw new Error("Managed policy changed during read");
    if (BigInt(total) !== before.size) throw new Error("Managed policy changed size");
    const document: unknown = JSON.parse(buffer.subarray(0, total).toString("utf8"));
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      Reflect.get(document, "version") !== 1 ||
      Object.keys(document).sort().join(",") !== "plugins,version"
    )
      throw new Error("Managed policy envelope invalid");
    const plugins: unknown = Reflect.get(document, "plugins");
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins))
      throw new Error("Managed policy plugin authority invalid");
    return { path: file, document };
  } finally {
    await handle.close();
  }
}
export async function qualifiedManagedEnvironment() {
  const policy = await readFixedManagedPluginPolicy();
  return { PATH: "/usr/bin:/bin", PASEO_MANAGED_PLUGIN_POLICY: policy.path };
}
/** CLI wrapper binds the same input, never an ambient policy path. */
export async function bindFixedManagedPluginPolicyEnvironment(): Promise<void> {
  const policy = await readFixedManagedPluginPolicy();
  const ambient = process.env.PASEO_MANAGED_PLUGIN_POLICY;
  if (ambient !== undefined && ambient !== policy.path)
    throw new Error("Managed policy environment mismatch");
  process.env.PASEO_MANAGED_PLUGIN_POLICY = policy.path;
}
