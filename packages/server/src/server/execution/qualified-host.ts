import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyEnclosingProcess, unsupported } from "./daemon-verifier.js";
import { assertQualifiedDaemonEvaluation, isQualifiedDaemonBinding } from "./daemon-owner.js";
export { getQualifiedDaemonOwner, isQualifiedDaemonOwner } from "./daemon-owner.js";
export type { QualifiedDaemonOwner } from "./daemon-types.js";
import { createHash, randomUUID } from "node:crypto";
import { qualifiedBindings } from "./qualified-bindings.js";
import { verifyQualifiedLaunch } from "./launch-verifier.js";
import type { HostEvidence, QualifiedExecutionBinding, QualifiedRole } from "./types.js";
export type { HostEvidence, QualifiedExecutionBinding, QualifiedRole } from "./types.js";

declare const __QUALIFIED_CHILD_ENTRY__: boolean;
let childRefresh: (() => Promise<void>) | null = null;
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
  if (expectedRole === "daemon") return isQualifiedDaemonBinding(value);
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
function assertQualifiedEvaluation(): void {
  if (current) {
    getQualifiedHost();
    return;
  }
  if (typeof __QUALIFIED_DAEMON_ENTRY__ !== "undefined" && __QUALIFIED_DAEMON_ENTRY__) {
    assertQualifiedDaemonEvaluation();
    return;
  }
  getQualifiedHost();
}
declare const __QUALIFIED_DAEMON_ENTRY__: boolean;
/** Finite SDK map; no dynamic package or builtin fallback in this profile. */
export function qualifiedRuntimeRequire(name: string): object {
  assertQualifiedEvaluation();
  const publicSdk = new Set([
    "@getpaseo/plugin",
    "@getpaseo/plugin/server",
    "@getpaseo/plugin/server/provider",
    "@getpaseo/plugin/server/acp",
    "@getpaseo/plugin/server/usage",
    "zod",
  ]);
  if (!publicSdk.has(name)) throw new Error("Private qualified host dependency");
  const namespace = Object.hasOwn(qualifiedBindings, name) ? qualifiedBindings[name] : undefined;
  if (!namespace) throw new Error("Unknown qualified host dependency");
  return namespace;
}
export function evaluateQualifiedBundle(source: string): unknown {
  assertQualifiedEvaluation();
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

/** Fixed sealed child startup; no caller-provided observation or namespace factory. */
export async function initializeQualifiedChildHost(): Promise<void> {
  if (current || typeof __QUALIFIED_CHILD_ENTRY__ === "undefined" || !__QUALIFIED_CHILD_ENTRY__)
    return unsupported();
  const file = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
  const root = path.dirname(file);
  const initial = await verifyEnclosingProcess(root);
  if (process.argv[1] !== path.join(root, "plugin-child-entry.mjs")) return unsupported();
  const incarnation = randomUUID();
  let fresh = true;
  const artifact = initial.manifest.files.find((entry) => entry.path === "plugin-worker-code.mjs");
  if (
    !artifact ||
    JSON.stringify(Object.keys(qualifiedBindings).sort()) !==
      JSON.stringify([...initial.manifest.bindingKeys].sort())
  )
    return unsupported();
  const evidence: HostEvidence = {
    schemaVersion: 1,
    role: "plugin-host",
    distributionBuildId: initial.manifest.distributionBuildId,
    roleBuildId: `${initial.manifest.distributionBuildId}:plugin-child`,
    qualificationManifestSha256: initial.manifestSha256,
    launchId: randomUUID(),
    parentLaunchId: null,
    process: {
      pid: process.pid,
      bootId: initial.observed.bootId,
      osBirthIdentity: initial.observed.birth,
      processStartToken: incarnation,
    },
    runtime: {
      artifactId: initial.manifest.runtime.sha256,
      platform: process.platform,
      arch: process.arch,
      observedExecutableIdentity: initial.observed.image,
    },
    bindings: Object.keys(qualifiedBindings)
      .sort()
      .map((bindingKey) => ({
        bindingKey,
        moduleBuildId: `${initial.manifest.distributionBuildId}:plugin-child`,
        artifactId: artifact.sha256,
        qualifiedOrigin: `${root}/plugin-worker-code.mjs#${bindingKey}`,
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
  const binding = Object.freeze({
    expectedClosure: initial.manifestSha256,
    expectedIncarnation: incarnation,
    capability: Object.freeze({
      evidenceDigest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
      assertQualifiedExecution(expectedClosure: unknown, expectedIncarnation: unknown): void {
        if (
          !fresh ||
          expectedClosure !== initial.manifestSha256 ||
          expectedIncarnation !== incarnation
        )
          return unsupported();
        for (const [key, namespace] of Object.entries(qualifiedBindings))
          if (identities.get(namespace) !== key) return unsupported();
      },
    }),
  });
  childRefresh = async () => {
    fresh = false;
    const now = await verifyEnclosingProcess(root);
    if (
      now.manifestSha256 !== initial.manifestSha256 ||
      now.observed.birth !== initial.observed.birth ||
      now.observed.image !== initial.observed.image ||
      JSON.stringify(now.closure) !== JSON.stringify(initial.closure)
    )
      return unsupported();
    fresh = true;
  };
  const activity = qualifiedBindings["@getpaseo/plugin/internal/activity"];
  const install = activity ? Reflect.get(activity, "installQualifiedHelperAdmission") : undefined;
  if (typeof install !== "function") return unsupported();
  install(() => {
    throw new Error("Qualified plugin external helper unsupported");
  });
  branded.set(binding, { role: "plugin-host", binding });
  current = Object.freeze({ binding, evidence, bindings: qualifiedBindings });
}
export async function refreshQualifiedChildHost(): Promise<void> {
  if (!childRefresh) return unsupported();
  await childRefresh();
}
