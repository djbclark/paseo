import { constants, type BigIntStats } from "node:fs";
import { open, lstat, realpath, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { FileIdentity } from "./types.js";

const keys = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
const stamp = (info: BigIntStats) => keys.map((key) => String(info[key])).join(":");
const selections = new WeakMap<
  object,
  { handle: FileHandle; identities: Map<string, string>; closed: boolean }
>();
export interface OriginalGitSelection {
  readonly path: "/usr/bin/git";
}
async function protectedSelectionPaths(): Promise<Map<string, string>> {
  const identities = new Map<string, string>();
  for (let current = "/usr/bin/git"; ; current = path.dirname(current)) {
    const info = await lstat(current, { bigint: true });
    if (info.uid !== 0n || info.mode & 0o022n || info.isSymbolicLink())
      throw new Error("Original Git selection unprotected");
    identities.set(current, stamp(info));
    if (current === "/") break;
  }
  if ((await realpath("/usr/bin/git")) !== "/usr/bin/git")
    throw new Error("Original Git alias unsupported");
  return identities;
}
/** Data/descriptor evidence only: cannot create a daemon owner or grant. */
export async function observeOriginalGitSelection(
  expected: FileIdentity,
): Promise<OriginalGitSelection> {
  if (
    expected.path !== "runtime/git" ||
    !Number.isSafeInteger(expected.size) ||
    expected.size <= 0 ||
    expected.size > 512 * 1024 * 1024
  )
    throw new Error("Retained Git identity unavailable");
  const identities = await protectedSelectionPaths();
  const handle = await open(
    "/usr/bin/git",
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      !(before.mode & 0o111n) ||
      stamp(before) !== identities.get("/usr/bin/git") ||
      before.size !== BigInt(expected.size)
    )
      throw new Error("Original Git image unsupported");
    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(65536);
      const read = await handle.read(buffer, 0, buffer.length, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
      if (total > expected.size) throw new Error("Original Git changed size");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (
      total !== expected.size ||
      hash.digest("hex") !== expected.sha256 ||
      stamp(await handle.stat({ bigint: true })) !== stamp(before)
    )
      throw new Error("Original Git differs from retained image");
    const proof = Object.freeze({ path: "/usr/bin/git" as const });
    selections.set(proof, { handle, identities, closed: false });
    await assertOriginalGitSelection(proof);
    return proof;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function assertOriginalGitSelection(proof: OriginalGitSelection): Promise<void> {
  const record = selections.get(proof);
  if (!record || record.closed) throw new Error("Original Git selection proof unavailable");
  const current = await protectedSelectionPaths();
  for (const [file, identity] of record.identities)
    if (current.get(file) !== identity) throw new Error("Original Git selection changed");
  if (stamp(await record.handle.stat({ bigint: true })) !== record.identities.get("/usr/bin/git"))
    throw new Error("Original Git descriptor changed");
}
export async function closeOriginalGitSelection(proof: OriginalGitSelection): Promise<void> {
  const record = selections.get(proof);
  if (!record || record.closed) return;
  record.closed = true;
  await record.handle.close();
}
