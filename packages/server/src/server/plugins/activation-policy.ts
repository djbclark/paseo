import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, mkdir, writeFile, rename } from "node:fs/promises";
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
});
export type ActivationOperation = "activate" | "recover";
export interface ActivationTicket {
  generation: number;
  authorization: z.infer<typeof Authorization>;
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
    if (!this.policyFile) return undefined;
    // Configured-but-unreadable/malformed policy holds EVERY activation, including unknown IDs.
    const policy = ManagedPluginPolicySchema.parse(
      JSON.parse(await readFile(this.policyFile, "utf8")),
    );
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
    if (!ticket && state.phase !== "ready" && !this.replacements.has(id) && operation !== "recover")
      throw new Error(`Plugin recovery required: ${id}`);
    if (
      ticket &&
      state.generation !== ticket.generation &&
      state.generation !== ticket.generation - 1
    )
      throw new Error("Activation generation changed");
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
    if (ticket && JSON.stringify(ticket.authorization) !== JSON.stringify(authorization))
      throw new Error(`Managed authorization changed: ${id}`);
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
    return { generation: generation + 1, authorization };
  }
  async arm(id: string, ticket: ActivationTicket | undefined): Promise<void> {
    if (ticket) {
      const state = await this.status(id);
      if (state.generation !== ticket.generation - 1)
        throw new Error("Stale activation generation");
      await this.save(id, { ...state, generation: ticket.generation, phase: "activating" });
    }
  }
  releaseReplacement(id: string): void {
    this.replacements.delete(id);
  }
  async committedReplacement(id: string): Promise<void> {
    this.replacements.delete(id);
    await this.save(id, { ...(await this.status(id)), phase: "ready" });
  }
  async finish(id: string, ticket: ActivationTicket | undefined, success: boolean): Promise<void> {
    if (ticket)
      await this.save(id, {
        ...(await this.status(id)),
        phase: success ? (this.replacements.has(id) ? "replacing" : "ready") : "held",
      });
    if (!success) this.replacements.delete(id);
  }
  async replacing(id: string, oldPath: string, candidatePath: string): Promise<void> {
    const state = await this.status(id);
    if (state.phase !== "ready") throw new Error("Plugin recovery required");
    await this.save(id, { ...state, phase: "replacing", oldPath, candidatePath });
    this.replacements.add(id);
  }
}
