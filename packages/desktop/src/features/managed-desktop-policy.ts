import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import { bundleSha256, stableFileSha256 } from "./managed-bundle.js";

const hex = z.string().regex(/^[0-9a-f]{64}$/);
const common = {
  allowed: z.literal(true),
  transactionId: z.string().min(1),
  receiptSha256: hex,
  version: z.string().min(1),
};
const schema = z.object({
  schemaVersion: z.literal(1),
  component: z.literal("paseo-desktop"),
  generation: z.number().int().positive(),
  stateCompatibility: z.literal("binary-only"),
  operations: z.object({
    download: z
      .object({ ...common, archiveSha256: hex, archiveSha512: z.string(), packageUrl: z.string() })
      .optional(),
    activate: z
      .object({ ...common, archiveSha256: hex, bundleSha256: hex, previousBundleSha256: hex })
      .optional(),
    recover: z.object({ ...common, bundleSha256: hex, previousBundleSha256: hex }).optional(),
  }),
});
function protectedPackageUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.endsWith(".zip")
    )
      throw new Error();
    return url;
  } catch {
    throw new Error("Invalid managed package URL");
  }
}

export type ManagedDesktopPolicy = z.infer<typeof schema>;

/** Fixed account home; HOME/PASEO_HOME cannot select authority. */
export function readManagedDesktopPolicy(): ManagedDesktopPolicy {
  const account = userInfo();
  const home = realpathSync(account.homedir);
  const file = path.join(home, ".local/state/djbclark-ade/forks/paseo-desktop-policy.json");
  for (
    let directory = path.dirname(file);
    directory !== path.dirname(home);
    directory = path.dirname(directory)
  ) {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.uid !== account.uid && stat.uid !== 0) ||
      (stat.mode & 0o022) !== 0
    )
      throw new Error("Managed desktop authority ancestor is not protected");
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== account.uid || (stat.mode & 0o022) !== 0) {
      throw new Error("Managed desktop authority is not protected");
    }
    if (stat.size > 65536) throw new Error("Managed desktop authority too large");
    const parsed = schema.parse(JSON.parse(readFileSync(fd, "utf8")));
    const after = fstatSync(fd);
    const current = lstatSync(file);
    if (
      stat.ino !== current.ino ||
      stat.dev !== current.dev ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw new Error("Managed desktop authority changed while reading");
    return parsed;
  } finally {
    closeSync(fd);
  }
}

/** Presence opts into managed mode even when the marker is malformed. */
export function isManagedDesktop(resources: string): boolean {
  try {
    lstatSync(path.join(resources, "managed-release.json"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

export class ManagedDesktopAuthority {
  private captured: string | null = null;

  packageUrl(): string {
    const policy = this.policy();
    const grant = policy.operations.download;
    if (!grant) throw new Error("Managed desktop download held");
    protectedPackageUrl(grant.packageUrl);
    const snapshot = JSON.stringify(policy);
    if (this.captured !== null && this.captured !== snapshot)
      throw new Error("Managed desktop authority changed");
    this.captured = snapshot;
    return grant.packageUrl;
  }
  constructor(private readonly read = readManagedDesktopPolicy) {}

  private policy(): ManagedDesktopPolicy {
    try {
      return schema.parse(this.read());
    } catch {
      throw new Error("Managed desktop policy unavailable or invalid");
    }
  }

  downloadMetadata(version: string, files: readonly { url: string; sha512: string }[]): string {
    const policy = this.policy();
    const grant = policy.operations.download;
    if (!grant || grant.version !== version) throw new Error("Managed desktop download held");
    const url = protectedPackageUrl(grant.packageUrl);
    const sha512 = Buffer.from(grant.archiveSha512, "base64");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.endsWith(".zip") ||
      sha512.length !== 64 ||
      sha512.toString("base64") !== grant.archiveSha512 ||
      files.length !== 1 ||
      !files.some(
        (file) =>
          new URL(file.url, grant.packageUrl).href === grant.packageUrl &&
          file.sha512 === grant.archiveSha512,
      )
    ) {
      throw new Error("Managed desktop package metadata mismatch");
    }
    const snapshot = JSON.stringify(policy);
    if (this.captured !== null && this.captured !== snapshot)
      throw new Error("Managed desktop authority changed");
    this.captured = snapshot;
    return grant.packageUrl;
  }

  assertUnchanged(): ManagedDesktopPolicy {
    const policy = this.policy();
    if (!this.captured || JSON.stringify(policy) !== this.captured)
      throw new Error("Managed desktop authority changed");
    return policy;
  }

  verifyArchive(file: string): void {
    const policy = this.assertUnchanged();
    if (stableFileSha256(file) !== policy.operations.download?.archiveSha256)
      throw new Error("Managed desktop archive mismatch");
    this.assertUnchanged();
  }

  verifyInstalledBundle(root: string, version: string): void {
    const policy = this.assertUnchanged();
    const grant = policy.operations.activate;
    const download = policy.operations.download;
    if (
      !grant ||
      !download ||
      grant.version !== version ||
      grant.transactionId !== download.transactionId ||
      grant.receiptSha256 !== download.receiptSha256 ||
      grant.archiveSha256 !== download.archiveSha256 ||
      bundleSha256(root) !== grant.previousBundleSha256
    )
      throw new Error("Managed desktop activation held");
    this.assertUnchanged();
  }
}
