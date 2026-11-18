import { createHash, randomUUID } from "node:crypto";
import { qualifiedBindings } from "./qualified-bindings.js";
import { verifyQualifiedLaunch } from "./launch-verifier.js";
import type { HostEvidence, QualifiedExecutionBinding, QualifiedRole } from "./types.js";
export type { HostEvidence, QualifiedExecutionBinding, QualifiedRole } from "./types.js";

const branded = new WeakMap<object, { role: QualifiedRole; binding: QualifiedExecutionBinding }>();
const identities = new WeakMap<object, string>();
let current: ReturnType<typeof produce> | null = null;

// Deliberately private: no caller-provided evidence, JSON or dependency injection.
function produce() {
  const launch = verifyQualifiedLaunch(__filename);
  const bindingKeys = Object.keys(qualifiedBindings).sort();
  if (JSON.stringify(bindingKeys) !== JSON.stringify([...launch.manifest.bindingKeys].sort()))
    throw new Error("Qualified bindings differ from enrolled closure");
  const incarnation = randomUUID();
  const launchId = randomUUID();
  const evidence: HostEvidence = {
    schemaVersion: 1,
    role: "plugin-host",
    distributionBuildId: launch.manifest.distributionBuildId,
    roleBuildId: launch.manifest.roleBuildId,
    qualificationManifestSha256: launch.manifestSha256,
    launchId,
    parentLaunchId: null,
    process: {
      pid: process.pid,
      bootId: launch.process.bootId,
      osBirthIdentity: launch.process.osBirthIdentity,
      processStartToken: incarnation,
    },
    runtime: {
      artifactId: launch.manifest.runtime.sha256,
      platform: process.platform,
      arch: process.arch,
      observedExecutableIdentity: launch.process.executableIdentity,
    },
    bindings: bindingKeys.map((bindingKey) => ({
      bindingKey,
      moduleBuildId: launch.manifest.roleBuildId,
      artifactId: launch.manifest.files.find((file) => file.path === "host.cjs")!.sha256,
      qualifiedOrigin: `${launch.root}/host.cjs#${bindingKey}`,
    })),
    helpers: [],
  };
  for (const [key, namespace] of Object.entries(qualifiedBindings)) identities.set(namespace, key);
  Object.freeze(evidence.process);
  Object.freeze(evidence.runtime);
  for (const row of evidence.bindings) Object.freeze(row);
  Object.freeze(evidence.bindings);
  Object.freeze(evidence.helpers);
  Object.freeze(evidence);
  const capability = Object.freeze({
    evidenceDigest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    assertQualifiedExecution(expectedClosure: unknown, expectedIncarnation: unknown): void {
      if (expectedClosure !== launch.manifestSha256 || expectedIncarnation !== incarnation)
        throw new Error("Qualified execution incarnation mismatch");
      const fresh = verifyQualifiedLaunch(__filename);
      if (
        fresh.manifestSha256 !== launch.manifestSha256 ||
        fresh.process.osBirthIdentity !== evidence.process.osBirthIdentity ||
        fresh.process.bootId !== evidence.process.bootId
      )
        throw new Error("Qualified execution changed");
      for (const [key, namespace] of Object.entries(qualifiedBindings))
        if (identities.get(namespace) !== key) throw new Error("Qualified module binding changed");
    },
  });
  const binding = Object.freeze({
    capability,
    expectedClosure: launch.manifestSha256,
    expectedIncarnation: incarnation,
  });
  branded.set(binding, { role: "plugin-host", binding });
  return Object.freeze({ binding, evidence, bindings: qualifiedBindings });
}
export function getQualifiedHost(): ReturnType<typeof produce> {
  current ??= produce();
  current.binding.capability.assertQualifiedExecution(
    current.binding.expectedClosure,
    current.binding.expectedIncarnation,
  );
  return current;
}
export function isQualifiedExecutionBinding(
  value: unknown,
  expectedRole: QualifiedRole,
): value is QualifiedExecutionBinding {
  if (!value || typeof value !== "object") return false;
  const record = branded.get(value);
  if (!record || record.role !== expectedRole) return false;
  try {
    record.binding.capability.assertQualifiedExecution(
      record.binding.expectedClosure,
      record.binding.expectedIncarnation,
    );
    return true;
  } catch {
    return false;
  }
}
/** Finite SDK map; no dynamic package or builtin fallback in this profile. */
export function qualifiedRuntimeRequire(name: string): object {
  getQualifiedHost();
  const namespace = Object.hasOwn(qualifiedBindings, name) ? qualifiedBindings[name] : undefined;
  if (!namespace) throw new Error("Unknown qualified host dependency");
  return namespace;
}
export function evaluateQualifiedBundle(source: string): unknown {
  getQualifiedHost();
  const factory = (0, eval)(source) as unknown;
  if (typeof factory !== "function") throw new Error("Invalid qualified bundle factory");
  return factory(qualifiedRuntimeRequire);
}

/** Evidence is inspectable after revocation; it never changes a loaded A into B. */
export function inspectQualifiedHost(): { evidence: HostEvidence; supported: boolean } {
  current ??= produce();
  return {
    evidence: current.evidence,
    supported: isQualifiedExecutionBinding(current.binding, "plugin-host"),
  };
}

/** First closure enrolls zero helpers; consumers must use this owner before spawn. */
export function assertQualifiedHelper(_helperId: string): never {
  getQualifiedHost();
  throw new Error("Qualified helper unsupported");
}
