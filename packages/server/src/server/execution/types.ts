export type QualifiedRole = "supervisor" | "daemon" | "plugin-host" | "compiler";
export interface QualifiedExecutionBinding {
  readonly capability: {
    readonly evidenceDigest: string;
    assertQualifiedExecution(expectedClosure: unknown, expectedIncarnation: unknown): void;
  };
  readonly expectedClosure: unknown;
  readonly expectedIncarnation: unknown;
}
export interface FileIdentity {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}
export interface HostManifest {
  schemaVersion: 1;
  role: "plugin-host";
  distributionBuildId: string;
  roleBuildId: string;
  files: FileIdentity[];
  runtime: FileIdentity;
  externalLibraries: FileIdentity[];
  helpers: never[];
  bindingKeys: string[];
}
export interface HostEvidence {
  schemaVersion: 1;
  role: "plugin-host";
  distributionBuildId: string;
  roleBuildId: string;
  qualificationManifestSha256: string;
  launchId: string;
  parentLaunchId: null;
  process: { pid: number; bootId: string; osBirthIdentity: string; processStartToken: string };
  runtime: {
    artifactId: string;
    platform: string;
    arch: string;
    observedExecutableIdentity: string;
  };
  bindings: Array<{
    bindingKey: string;
    moduleBuildId: string;
    artifactId: string;
    qualifiedOrigin: string;
  }>;
  helpers: never[];
}
