import type { TerminalWorkerRecord } from "../../terminal/terminal-worker-record.js";
import type { ChildProcess } from "node:child_process";
import type { Worker } from "node:worker_threads";
import type { FileIdentity, QualifiedExecutionBinding, HostEvidence } from "./types.js";
export interface QualifiedClosure {
  runtimeClosureSha256: string;
  helperClosureSha256: string;
  qualificationSha256: string;
}
export interface DaemonManifest {
  schemaVersion: 2;
  profile: "enclosing-daemon-v2";
  distributionBuildId: string;
  files: FileIdentity[];
  runtime: FileIdentity;
  externalLibraries: FileIdentity[];
  esbuild: FileIdentity;
  helperInventory: FileIdentity[];
  helperClosureSha256: string;
  entries: {
    terminal: "terminal-entry.mjs";
    daemon: "daemon.mjs";
    pluginChild: "plugin-child-entry.mjs";
    compiler: "compiler-entry.mjs";
  };
  bindingKeys: string[];
}
export interface OwnedObservation {
  /** Data-only namespace receipt from actual verified plugin-child realm. */
  hostEvidence?: HostEvidence;
  manifestSha256: string;
  distributionBuildId: string;
  incarnation: string;
  pid: number;
  threadId?: number;
  challenge: string;
}
export interface QualifiedOwnedChild {
  readonly closure: Readonly<QualifiedClosure>;
  readonly child: ChildProcess;
  /** Transport routing only: exact pending nonce replies privately validated on this handle. */
  consumeObservation(raw: unknown): boolean;
  readonly incarnation: string;
  assertFresh(): void;
  challenge(): Promise<OwnedObservation>;
}
export interface QualifiedOwnedCompiler {
  readonly closure: Readonly<QualifiedClosure>;
  readonly worker: Worker;
  /** Actual helper-close ACK plus verified Worker exit; control timeouts never settle it. */
  readonly settled: Promise<void>;
  close(): Promise<void>;
  readonly incarnation: string;
  assertFresh(): void;
}
export interface QualifiedDaemonOwner {
  readonly binding: QualifiedExecutionBinding;
  readonly evidenceDigest: string;
  readonly root: string;
  readonly closure: Readonly<QualifiedClosure>;
  assertQualification(expected: QualifiedClosure, expectedIncarnation: string): void;
  assertFresh(): void;
  refresh(): Promise<void>;
  launchPluginChild(): Promise<QualifiedOwnedChild>;
  createCompilerWorker(): Promise<QualifiedOwnedCompiler>;
  launchTerminalWorker(input: {
    paseoHome: string;
    paseoVersion: string;
    timeoutMs?: number;
  }): Promise<{ record: TerminalWorkerRecord; recordPath: string }>;
  assertOwnedTerminalWorker(record: unknown): void;
  assertOwnedExecutionHandle(
    handle: ChildProcess | Worker,
    kind: "plugin-child" | "compiler" | "terminal-worker",
    incarnation: string,
  ): void;
}

/** Serializable observations only; none of these fields is an admission capability. */
export interface QualifiedDaemonObservation {
  schemaVersion: 1;
  role: "daemon";
  distributionBuildId: string;
  manifestSha256: string;
  pid: number;
  incarnation: string;
  bootId: string;
  osBirthIdentity: string;
  executable: string;
  executableIdentity: string;
  evidenceDigest: string;
  closure: Readonly<QualifiedClosure>;
  namespaces: readonly {
    bindingKey: string;
    moduleBuildId: string;
    artifactSha256: string;
    qualifiedOrigin: string;
  }[];
  ownedHandles: readonly {
    kind: "plugin-child" | "compiler" | "terminal-worker";
    pid: number;
    threadId: number | null;
    incarnation: string;
  }[];
}
