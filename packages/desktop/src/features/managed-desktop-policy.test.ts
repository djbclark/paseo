import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { bundleSha256 } from "./managed-bundle";
import {
  isManagedDesktop,
  ManagedDesktopAuthority,
  type ManagedDesktopPolicy,
} from "./managed-desktop-policy";

const directories: string[] = [];
function temporary() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-managed-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hex = "a".repeat(64);
const sha512 = Buffer.alloc(64, 1).toString("base64");
function policy(): ManagedDesktopPolicy {
  return {
    schemaVersion: 1,
    component: "paseo-desktop",
    generation: 1,
    stateCompatibility: "binary-only",
    operations: {
      download: {
        allowed: true,
        transactionId: "transaction",
        receiptSha256: hex,
        version: "1.2.4",
        archiveSha256: hex,
        archiveSha512: sha512,
        packageUrl: "https://example.com/qualified/app.zip",
      },
      activate: {
        allowed: true,
        transactionId: "transaction",
        receiptSha256: hex,
        version: "1.2.4",
        archiveSha256: hex,
        bundleSha256: hex,
        previousBundleSha256: hex,
      },
    },
  };
}
const metadata = [{ url: "app.zip", sha512 }];
describe("managed authority", () => {
  it("marker presence selects managed behavior without granting permission", () => {
    const root = temporary();
    expect(isManagedDesktop(root)).toBe(false);
    writeFileSync(path.join(root, "managed-release.json"), "corrupt");
    expect(isManagedDesktop(root)).toBe(true);
    const authority = new ManagedDesktopAuthority(() => {
      throw new Error("missing policy");
    });
    expect(() => authority.packageUrl()).toThrow("policy unavailable");
  });
  it.each(["version", "url", "sha512"])("rejects mismatched %s metadata", (field) => {
    const authority = new ManagedDesktopAuthority(policy);
    expect(() =>
      authority.downloadMetadata(field === "version" ? "other" : "1.2.4", [
        {
          url: field === "url" ? "evil.zip" : "app.zip",
          sha512: field === "sha512" ? "bad" : sha512,
        },
      ]),
    ).toThrow();
  });
  it.each([
    "http://example.com/app.zip",
    "https://user:secret@example.com/app.zip",
    "https://example.com/app.zip#fragment",
    "https://example.com/app.exe",
  ])("rejects an unsafe archive URL", (packageUrl) => {
    const current = policy();
    current.operations.download!.packageUrl = packageUrl;
    expect(() =>
      new ManagedDesktopAuthority(() => current).downloadMetadata("1.2.4", [
        { url: packageUrl, sha512 },
      ]),
    ).toThrow();
  });
  it("holds policy changes during metadata wait and revocation after acquisition", () => {
    let current = policy();
    const authority = new ManagedDesktopAuthority(() => current);
    authority.packageUrl();
    current = { ...current, generation: 2 };
    expect(() => authority.downloadMetadata("1.2.4", metadata)).toThrow("changed");
    expect(() => authority.assertUnchanged()).toThrow("changed");
    current = { ...current, operations: {} };
    expect(() => authority.downloadMetadata("1.2.4", metadata)).toThrow();
  });
  it("rejects malformed authority and non binary state compatibility", () => {
    for (const change of [
      { generation: 0 },
      { schemaVersion: 2 },
      { stateCompatibility: "migration" },
    ]) {
      expect(() =>
        new ManagedDesktopAuthority(
          () => ({ ...policy(), ...change }) as ManagedDesktopPolicy,
        ).packageUrl(),
      ).toThrow();
    }
  });
  it("verifies actual cached bytes again and rejects substituted symlinks", () => {
    const root = temporary();
    const file = path.join(root, "app.zip");
    writeFileSync(file, "qualified");
    const current = policy();
    current.operations.download!.archiveSha256 = createHash("sha256")
      .update("qualified")
      .digest("hex");
    const authority = new ManagedDesktopAuthority(() => current);
    authority.downloadMetadata("1.2.4", metadata);
    authority.verifyArchive(file);
    writeFileSync(file, "tampered");
    expect(() => authority.verifyArchive(file)).toThrow("mismatch");
    const link = path.join(root, "cache.zip");
    symlinkSync(file, link);
    expect(() => authority.verifyArchive(link)).toThrow();
  });
  it("requires exact current bundle identity and transaction binding", () => {
    const root = temporary();
    writeFileSync(path.join(root, "app"), "installed");
    const current = policy();
    current.operations.activate!.previousBundleSha256 = bundleSha256(root);
    const authority = new ManagedDesktopAuthority(() => current);
    authority.downloadMetadata("1.2.4", metadata);
    authority.verifyInstalledBundle(root, "1.2.4");
    writeFileSync(path.join(root, "app"), "changed");
    expect(() => authority.verifyInstalledBundle(root, "1.2.4")).toThrow("held");
  });
});
describe("bundle hash v1", () => {
  it("matches Python JSONL for whole Unicode artifact including modes, directories and symlinks", () => {
    const root = temporary();
    mkdirSync(path.join(root, "empty"));
    chmodSync(path.join(root, "empty"), 0o755);
    for (const name of ["é.txt", "😀.txt", "\uE000.txt", "manifest.json"]) {
      writeFileSync(path.join(root, name), name);
      chmodSync(path.join(root, name), 0o644);
    }
    symlinkSync("é.txt", path.join(root, "link"));
    const result = spawnSync(
      "python3",
      [path.resolve("src/features/test-utils/bundle-hash-v1.py"), root],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(bundleSha256(root)).toBe(result.stdout.trim());
    const before = bundleSha256(root);
    writeFileSync(path.join(root, "manifest.json"), "changed");
    expect(bundleSha256(root)).not.toBe(before);
  });
  it("rejects outside and broken symlinks", () => {
    const root = temporary();
    symlinkSync(os.tmpdir(), path.join(root, "outside"));
    expect(() => bundleSha256(root)).toThrow();
  });
});
