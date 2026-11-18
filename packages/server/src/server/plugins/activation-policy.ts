import { constants } from "node:fs";
import { PluginLoadedReceiptSchema, type PluginLoadedReceipt } from "@getpaseo/protocol/messages";
import { PluginSourceSchema, type PluginSource } from "@getpaseo/protocol/plugin-config";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  open,
  realpath,
  mkdir,
  writeFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PassivePluginProfileSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("native-passive-contract-1"),
    qualificationSha256: Digest,
    runtimeClosureSha256: Digest,
    helperClosureSha256: Digest,
    initialization: z.literal("registration-only"),
  })
  .strict();
export type PassivePluginProfile = z.infer<typeof PassivePluginProfileSchema>;
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
  })
  .strict();
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
      return State.parse(JSON.parse(await readFile(this.stateFile(id), "utf8")));
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
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, target);
  }
  async authorize(
    id: string,
    directory: string,
    operation: ActivationOperation = "activate",
    bundle?: string,
    ticket?: ActivationTicket,
  ): Promise<ActivationTicket | undefined> {
    if (this.policyFile === undefined) return undefined;
    // Configured-but-unreadable/malformed policy holds EVERY activation, including unknown IDs.
    const rawPolicy = await readFile(this.policyFile, "utf8");
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
    if ((await readFile(this.policyFile, "utf8")) !== rawPolicy)
      throw new Error("Managed policy changed during verification");
    return { generation: generation + 1, authorization, policyRevision };
  }
  async assertNativeAcquisitionAllowed(id?: string): Promise<void> {
    if (this.policyFile === undefined) {
      await this.assertUnconfiguredNativeAcquisition(id);
      return;
    }
    const policy = ManagedPluginPolicySchema.parse(
      JSON.parse(await readFile(this.policyFile, "utf8")),
    );
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

  async dispatchAuthorized(input: PluginDispatch): Promise<void> {
    const { id, ticket, canPublish, dispatch } = input;
    if (this.policyFile !== undefined) {
      const rawPolicy = await readFile(this.policyFile, "utf8");
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
