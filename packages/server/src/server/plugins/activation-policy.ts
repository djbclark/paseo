import {
  PassivePluginProfileSchema,
  DirectoryHelperPluginProfileSchema,
  type PassivePluginProfile,
  type ManagedPluginExecutionProfile,
} from "./execution-profile.js";
export {
  PassivePluginProfileSchema,
  DirectoryHelperPluginProfileSchema,
} from "./execution-profile.js";
export type {
  PassivePluginProfile,
  DirectoryHelperPluginProfile,
  ManagedPluginExecutionProfile,
} from "./execution-profile.js";
import { isQualifiedDaemonOwner } from "../execution/qualified-host.js";
import type { QualifiedDaemonOwner } from "../execution/daemon-types.js";
import { readFixedManagedPluginPolicy } from "../execution/managed-policy-environment.js";
import { constants } from "node:fs";
import {
  PluginIdSchema,
  PluginLoadedReceiptSchema,
  type PluginLoadedReceipt,
} from "@getpaseo/protocol/messages";
import { PluginSourceSchema, type PluginSource } from "@getpaseo/protocol/plugin-config";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, open, realpath, mkdir, rm, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);

const Authorization = z
  .object({
    operation: z.enum(["activate", "recover"]),
    expectedGeneration: z.number().int().nonnegative(),
    sourcePath: z.string(),
    snapshotRoot: z.string(),
    snapshotSha256: Digest,
    serverBundleSha256: Digest,
    state: z.literal("binary-only"),
    forbiddenEnvironment: z.array(z.string()),
    passiveProfile: PassivePluginProfileSchema.optional(),
    directoryHelperProfile: DirectoryHelperPluginProfileSchema.optional(),
  })
  .strict()
  .refine(
    (authorization) => !(authorization.passiveProfile && authorization.directoryHelperProfile),
    "Managed execution profiles are mutually exclusive",
  );
export const ManagedPluginPolicySchema = z
  .object({
    version: z.literal(1),
    plugins: z.record(z.string(), z.object({ authorizations: z.array(Authorization) }).strict()),
  })
  .strict();
const State = z.object({
  version: z.literal(1),
  generation: z.number().int().nonnegative(),
  phase: z.enum(["ready", "activating", "replacing", "held"]),
  enrolled: z.boolean().optional(),
  oldPath: z.string().optional(),
  candidatePath: z.string().optional(),
  baseline: z.object({ source: PluginSourceSchema, receipt: PluginLoadedReceiptSchema }).optional(),
  currentReceipt: PluginLoadedReceiptSchema.optional(),
});
export type ManagedPluginActivationState = z.infer<typeof State>;
type ManagedAuthorization = z.infer<typeof Authorization>;
type ProfileAuthorization = Pick<ManagedAuthorization, "passiveProfile" | "directoryHelperProfile">;
/** Protected expectations propagate unchanged; metadata does not qualify execution. */
export function managedPluginExecutionProfile(
  authorization: ProfileAuthorization,
): ManagedPluginExecutionProfile | undefined {
  if (authorization.passiveProfile && authorization.directoryHelperProfile)
    throw new Error("Managed execution profiles are mutually exclusive");
  return authorization.directoryHelperProfile ?? authorization.passiveProfile;
}
/** New realm support requires the genuine producer; never fall through to an ordinary child. */
export function requireAvailablePluginExecutionProfile(
  authorization: ProfileAuthorization | undefined,
): PassivePluginProfile | undefined {
  const profile = authorization && managedPluginExecutionProfile(authorization);
  if (profile?.contract === "ade-directory-helpers-v1")
    throw new Error("Qualified ADE directory helper execution producer unavailable");
  return profile;
}
export type ActivationOperation = "activate" | "recover";
export interface ActivationTicket {
  generation: number;
  authorization: z.infer<typeof Authorization>;
  policyRevision: string;
}

/** Hash the complete administrator snapshot, including helper dependencies. Symlinks are refused. */
export async function hashPluginSnapshot(root: string): Promise<string> {
  if ((await realpath(root)) !== root) throw new Error("Snapshot root must be canonical");
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (stat.isDirectory()) {
        hash.update(JSON.stringify(["directory", relative]) + "\n");
        await visit(file);
      } else if (stat.isFile()) {
        hash.update(JSON.stringify(["file", relative, stat.mode & 0o777, stat.size]) + "\n");
        hash.update(await readFile(file));
        hash.update("\n");
      } else throw new Error(`Snapshot contains a non-regular entry: ${relative}`);
    }
  }
  await visit(root);
  return hash.digest("hex");
}

export class ManagedPluginActivationPolicy {
  private qualifiedOwner: QualifiedDaemonOwner | undefined;
  bindQualifiedAuthority(owner: QualifiedDaemonOwner): void {
    if (!isQualifiedDaemonOwner(owner) || (this.qualifiedOwner && this.qualifiedOwner !== owner))
      throw new Error("Managed policy qualified owner mismatch");
    this.qualifiedOwner = owner;
  }
  private policyObservationEpoch = 0;
  private lastPolicyBytes: string | undefined;
  getObservationEpoch(): number {
    return this.policyObservationEpoch;
  }
  private async readPolicy(): Promise<string> {
    if (!this.policyFile) throw new Error("Managed policy unavailable");
    let raw: string;
    if (!this.qualifiedOwner) raw = await readFile(this.policyFile, "utf8");
    else {
      await this.qualifiedOwner.refresh();
      const policy = await readFixedManagedPluginPolicy();
      if (policy.path !== this.policyFile)
        throw new Error("Qualified managed policy path mismatch");
      await this.qualifiedOwner.refresh();
      this.qualifiedOwner.assertFresh();
      raw = JSON.stringify(policy.document);
    }
    if (raw !== this.lastPolicyBytes) {
      this.lastPolicyBytes = raw;
      this.policyObservationEpoch++;
    }
    return raw;
  }
  private readonly enrolled = new Set<string>();
  private readonly replacements = new Set<string>();
  constructor(
    private readonly policyFile: string | undefined,
    private readonly stateDirectory: string,
  ) {}
  get configured(): boolean {
    return this.policyFile !== undefined;
  }
  private stateFile(id: string): string {
    return path.join(this.stateDirectory, `${encodeURIComponent(id)}.json`);
  }
  async status(id: string): Promise<z.infer<typeof State>> {
    try {
      return (await this.observeStatus(id)).state;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { version: 1, generation: 0, phase: "ready" };
      throw error;
    }
  }
  async observeStatus(
    id: string,
  ): Promise<{ state: ManagedPluginActivationState; identity: string }> {
    const nofollow = constants.O_NOFOLLOW;
    const nonblock = constants.O_NONBLOCK;
    if (typeof nofollow !== "number" || typeof nonblock !== "number")
      throw new Error("Protected journal reads are unsupported");
    const target = path.resolve(this.stateFile(id));
    if (path.dirname(target) !== path.resolve(this.stateDirectory))
      throw new Error("Invalid plugin journal path");
    const file = await open(target, constants.O_RDONLY | nofollow | nonblock);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 65536)
        throw new Error("Invalid plugin journal size/type");
      // One bounded regular-file read also detects growth after the initial descriptor stat.
      const buffer = Buffer.alloc(before.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== before.size) throw new Error("Plugin journal changed during bounded read");
      const bytes = buffer.subarray(0, bytesRead).toString("utf8");
      const after = await file.stat();
      const named = await lstat(target);
      if (!named.isFile()) throw new Error("Plugin journal is not a regular file");
      if (
        named.dev !== after.dev ||
        named.ino !== after.ino ||
        named.mtimeMs !== after.mtimeMs ||
        named.ctimeMs !== after.ctimeMs
      )
        throw new Error("Plugin journal was replaced during read");
      if (
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.size !== after.size
      )
        throw new Error("Plugin journal changed during read");
      return {
        state: State.parse(JSON.parse(bytes)),
        identity: JSON.stringify([
          after.dev,
          after.ino,
          after.mtimeMs,
          after.ctimeMs,
          after.size,
          createHash("sha256").update(bytes).digest("hex"),
        ]),
      };
    } finally {
      await file.close();
    }
  }
  private async save(id: string, state: z.infer<typeof State>): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    const target = this.stateFile(id);
    const temp = `${target}.${randomUUID()}.tmp`;
    const descriptor = await open(temp, "wx", 0o600);
    try {
      await descriptor.writeFile(JSON.stringify(state));
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    try {
      await rename(temp, target);
      const directory = await open(this.stateDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
  async authorize(
    id: string,
    directory: string,
    operation: ActivationOperation = "activate",
    bundle?: string,
    ticket?: ActivationTicket,
  ): Promise<ActivationTicket | undefined> {
    if (this.policyFile === undefined) {
      await this.assertUnconfiguredActivationAllowed(id);
      return undefined;
    }
    // Configured-but-unreadable/malformed policy holds EVERY activation, including unknown IDs.
    const rawPolicy = await this.readPolicy();
    const policyRevision = createHash("sha256").update(rawPolicy).digest("hex");
    const policy = ManagedPluginPolicySchema.parse(JSON.parse(rawPolicy));
    const state = await this.status(id);
    const entry = policy.plugins[id];
    if (!entry && !this.enrolled.has(id) && state.generation === 0 && !state.enrolled)
      return undefined;
    this.enrolled.add(id);
    if (entry && !state.enrolled) {
      state.enrolled = true;
      await this.save(id, state);
    }
    if (!entry) throw new Error(`Managed plugin authorization removed: ${id}`);
    this.assertJournalActivation({ id, state, operation, ticket });
    const generation = ticket ? ticket.generation - 1 : state.generation;
    const canonical = await realpath(directory);
    const matches = entry.authorizations.filter(
      (item) =>
        item.operation === operation &&
        item.expectedGeneration === generation &&
        item.sourcePath === canonical,
    );
    const authorization = matches.length === 1 ? matches[0] : undefined;
    if (!authorization || canonical !== path.resolve(directory))
      throw new Error(`No exact managed activation authorization: ${id}`);
    if (operation === "recover") assertRecoveryIdentity(state, canonical, authorization);
    if (ticket && JSON.stringify(ticket.authorization) !== JSON.stringify(authorization))
      throw new Error(`Managed authorization changed: ${id}`);
    await verifyAuthorizedArtifact({ id, canonical, authorization, bundle });
    if ((await this.readPolicy()) !== rawPolicy)
      throw new Error("Managed policy changed during verification");
    return { generation: generation + 1, authorization, policyRevision };
  }
  /** Activation callers cannot downgrade an unsupported protected realm to an ordinary child. */
  async authorizeForExecution(
    id: string,
    directory: string,
    operation: ActivationOperation = "activate",
    bundle?: string,
    ticket?: ActivationTicket,
  ): Promise<ActivationTicket | undefined> {
    const current = await this.authorize(id, directory, operation, bundle, ticket);
    requireAvailablePluginExecutionProfile(current?.authorization);
    return current;
  }
  async assertNativeAcquisitionAllowed(id?: string): Promise<void> {
    if (this.policyFile === undefined) {
      await this.assertUnconfiguredNativeAcquisition(id);
      return;
    }
    const policy = ManagedPluginPolicySchema.parse(JSON.parse(await this.readPolicy()));
    if (id === undefined)
      throw new Error(
        "Configured managed policy requires an explicit runtime ID before native acquisition",
      );
    const state = await this.status(id);
    if (policy.plugins[id]) {
      this.enrolled.add(id);
      if (!state.enrolled) await this.save(id, { ...state, enrolled: true });
    }
    if (policy.plugins[id] || this.enrolled.has(id) || state.enrolled || state.generation > 0)
      throw new Error(
        "Managed native acquisition is unsupported; use qualified directory replacement",
      );
  }

  // Removing daemon policy cannot erase protected enrollment history.
  private async assertUnconfiguredActivationAllowed(id: string): Promise<void> {
    const existing = await lstat(this.stateFile(id)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    const history = existing ? (await this.observeStatus(id)).state : undefined;
    if (this.enrolled.has(id) || history?.enrolled || (history?.generation ?? 0) > 0)
      throw new Error(`Managed plugin policy is not configured: ${id}`);
  }

  private async assertUnconfiguredNativeAcquisition(id: string | undefined): Promise<void> {
    if (id !== undefined) {
      const state = await this.status(id);
      if (state.enrolled || state.generation > 0)
        throw new Error("Managed native acquisition requires configured policy");
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(this.stateDirectory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (entries.length || this.enrolled.size)
      throw new Error("Managed history requires an explicit runtime ID before native acquisition");
  }

  async observeEnrollment(): Promise<{ ids: string[]; identity: string }> {
    if (!this.policyFile) throw new Error("Managed policy unavailable");
    const raw = await this.readPolicy();
    const policy = ManagedPluginPolicySchema.parse(JSON.parse(raw));
    let names: string[] = [];
    let directoryIdentity = "missing";
    try {
      const info = await lstat(this.stateDirectory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Invalid journal directory");
      names = (await readdir(this.stateDirectory)).filter((name) => name.endsWith(".json")).sort();
      directoryIdentity = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const ids = [
      ...new Set([
        ...Object.keys(policy.plugins),
        ...names.map((name) => {
          const id = decodeURIComponent(name.slice(0, -5));
          if (`${encodeURIComponent(id)}.json` !== name) throw new Error("Invalid journal name");
          return id;
        }),
        ...this.enrolled,
      ]),
    ].sort();
    for (const id of ids) PluginIdSchema.parse(id);
    return {
      ids,
      identity: createHash("sha256")
        .update(JSON.stringify([raw, names, directoryIdentity]))
        .digest("hex"),
    };
  }

  async observeLoadedQualification(
    id: string,
    receipt: PluginLoadedReceipt,
    ticket: ActivationTicket,
  ): Promise<string> {
    if (!this.policyFile || !managedPluginExecutionProfile(ticket.authorization))
      throw new Error("Loaded passive authority unavailable");
    const raw = await this.readPolicy();
    const policy = ManagedPluginPolicySchema.parse(JSON.parse(raw));
    const matching = policy.plugins[id]?.authorizations.filter(
      (authorization) => JSON.stringify(authorization) === JSON.stringify(ticket.authorization),
    );
    if (
      matching?.length !== 1 ||
      receipt.activationGeneration !== ticket.generation ||
      receipt.sourcePath !== ticket.authorization.sourcePath ||
      receipt.serverBundleSha256 !== ticket.authorization.serverBundleSha256 ||
      receipt.snapshotSha256 !== ticket.authorization.snapshotSha256 ||
      receipt.snapshotRoot !== ticket.authorization.snapshotRoot
    )
      throw new Error("Loaded passive authority revoked or ambiguous");
    await verifyAuthorizedArtifact({
      id,
      canonical: receipt.sourcePath,
      authorization: ticket.authorization,
      bundle: undefined,
    });
    const current = await this.observeStatus(id);
    if (
      JSON.stringify(current.state.currentReceipt) !== JSON.stringify(receipt) ||
      (await this.readPolicy()) !== raw
    )
      throw new Error("Loaded passive authority changed");
    return createHash("sha256").update(raw).digest("hex");
  }

  async dispatchAuthorized(input: PluginDispatch): Promise<void> {
    const { id, ticket, canPublish, dispatch } = input;
    if (this.policyFile !== undefined) {
      const rawPolicy = await this.readPolicy();
      const policy = ManagedPluginPolicySchema.parse(JSON.parse(rawPolicy));
      if (!ticket && (policy.plugins[id] || this.enrolled.has(id)))
        throw new Error("Managed enrollment changed before initialize");
      if (ticket && createHash("sha256").update(rawPolicy).digest("hex") !== ticket.policyRevision)
        throw new Error("Managed policy changed before initialize");
    }
    // Dispatch is synchronous after the final policy read and cancellation check; no intervening await.
    if (!canPublish()) throw new Error(`Plugin start cancelled: ${id}`);
    dispatch();
  }

  private assertJournalActivation(input: JournalActivationCheck): void {
    const { id, state, operation, ticket } = input;
    if (!ticket && state.phase !== "ready" && !this.replacements.has(id) && operation !== "recover")
      throw new Error(`Plugin recovery required: ${id}`);
    if (
      ticket &&
      state.generation !== ticket.generation &&
      state.generation !== ticket.generation - 1
    )
      throw new Error("Activation generation changed");
  }

  async arm(id: string, ticket: ActivationTicket | undefined): Promise<void> {
    if (ticket) {
      const state = await this.status(id);
      if (state.generation !== ticket.generation - 1)
        throw new Error("Stale activation generation");
      await this.save(id, {
        ...state,
        generation: ticket.generation,
        phase: "activating",
        ...(state.phase === "ready" && state.currentReceipt
          ? {
              oldPath: state.currentReceipt.sourcePath,
              candidatePath: ticket.authorization.sourcePath,
              baseline: {
                source: {
                  source: "directory",
                  path: state.currentReceipt.sourcePath,
                  enabled: true,
                },
                receipt: state.currentReceipt,
              },
            }
          : {}),
      });
    }
  }
  async recordLoaded(
    id: string,
    ticket: ActivationTicket | undefined,
    receipt: PluginLoadedReceipt,
  ): Promise<void> {
    if (ticket) await this.save(id, { ...(await this.status(id)), currentReceipt: receipt });
  }
  async hold(id: string): Promise<void> {
    this.replacements.delete(id);
    await this.save(id, { ...(await this.status(id)), phase: "held" });
  }
  async recovering(id: string, expectedGeneration: number): Promise<void> {
    const state = await this.status(id);
    if (state.generation !== expectedGeneration || !state.baseline)
      throw new Error("Recovery journal CAS mismatch or missing baseline");
    await this.save(id, { ...state, phase: "replacing" });
    this.replacements.add(id);
  }
  releaseReplacement(id: string): void {
    this.replacements.delete(id);
  }
  async committedReplacement(id: string): Promise<void> {
    this.replacements.delete(id);
    await this.save(id, { ...(await this.status(id)), phase: "ready" });
  }
  async finish(id: string, ticket: ActivationTicket | undefined, success: boolean): Promise<void> {
    let phase: ManagedPluginActivationState["phase"] = "held";
    if (success) phase = this.replacements.has(id) ? "replacing" : "ready";
    if (ticket) await this.save(id, { ...(await this.status(id)), phase });
    if (!success) this.replacements.delete(id);
  }
  async replacing(
    id: string,
    oldPath: string,
    candidatePath: string,
    baseline?: { source: PluginSource; receipt: PluginLoadedReceipt },
  ): Promise<void> {
    const state = await this.status(id);
    if (state.phase !== "ready") throw new Error("Plugin recovery required");
    await this.save(id, { ...state, phase: "replacing", oldPath, candidatePath, baseline });
    this.replacements.add(id);
  }
}

interface JournalActivationCheck {
  id: string;
  state: ManagedPluginActivationState;
  operation: ActivationOperation;
  ticket: ActivationTicket | undefined;
}
interface AuthorizedArtifactCheck {
  id: string;
  canonical: string;
  authorization: ManagedAuthorization;
  bundle: string | undefined;
}
function assertRecoveryIdentity(
  state: ManagedPluginActivationState,
  canonical: string,
  authorization: ManagedAuthorization,
): void {
  const baseline = state.baseline;
  if (
    !baseline ||
    baseline.receipt.sourcePath !== canonical ||
    baseline.receipt.serverBundleSha256 !== authorization.serverBundleSha256 ||
    baseline.receipt.snapshotRoot !== authorization.snapshotRoot ||
    baseline.receipt.snapshotSha256 !== authorization.snapshotSha256
  )
    throw new Error("Recovery authorization differs from recorded loaded baseline");
}
async function verifyAuthorizedArtifact(input: AuthorizedArtifactCheck): Promise<void> {
  const { id, canonical, authorization, bundle } = input;
  const relative = path.relative(authorization.snapshotRoot, canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Plugin outside authorized snapshot");
  for (const key of authorization.forbiddenEnvironment)
    if (process.env[key] !== undefined)
      throw new Error(`Forbidden plugin environment override: ${key}`);
  if ((await hashPluginSnapshot(authorization.snapshotRoot)) !== authorization.snapshotSha256)
    throw new Error(`Managed snapshot digest mismatch: ${id}`);
  if (
    bundle !== undefined &&
    createHash("sha256").update(bundle).digest("hex") !== authorization.serverBundleSha256
  )
    throw new Error(`Compiled server bundle digest mismatch: ${id}`);
}

interface PluginDispatch {
  id: string;
  ticket: ActivationTicket | undefined;
  canPublish: () => boolean;
  dispatch: () => void;
}
