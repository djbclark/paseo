import { assertHeldPluginOperationResult } from "./maintenance-operation.js";
import type {
  HeldPluginOperationClaim,
  HeldPluginOperationScope,
  HeldPluginOperationDriver,
} from "./maintenance-operation.js";
import {
  emptyMaintenanceParticipant,
  type PluginMaintenancePort,
  type MaintenanceIdentity,
  type QualifiedDaemonAccess,
} from "./maintenance-participant.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  MISSING_MAINTENANCE_AUTHORITY,
  readProtectedMaintenanceJson,
  parseMaintenanceRecord,
  validateMaintenanceEnrollment,
  type MaintenanceRecord,
} from "./maintenance-offline.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { renameSync } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";

export interface MaintenanceStatus {
  schemaVersion: 1;
  state: "idle" | "held" | "recovery-required";
  generation: number | null;
  reservationGeneration: number;
  ready: boolean;
  transactionId: string | null;
  recoveryRequired: boolean;
}
const knownBusyRefusals = new WeakSet<object>();
function knownBusyRefusal(): Error {
  const error = new Error("Maintenance reservation refused");
  knownBusyRefusals.add(error);
  return error;
}
/** Classification is native-private; messages and caller supplied codes never grant it. */
export function maintenanceBeginErrorCode(error: unknown): "MAINTENANCE_KNOWN_BUSY" | undefined {
  if (typeof error === "object" && error !== null && knownBusyRefusals.has(error))
    return "MAINTENANCE_KNOWN_BUSY";
  return undefined;
}
type RecordV1 = MaintenanceRecord;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

interface ExecutionScope {
  owner: MaintenanceReservation;
  leases: (() => void)[];
}
const executionOwner = new AsyncLocalStorage<ExecutionScope | undefined>();
export function currentMaintenanceExecution(): MaintenanceReservation | undefined {
  return executionOwner.getStore()?.owner;
}

interface HeldScopeEntry {
  readonly claim: HeldPluginOperationClaim;
  readonly owner: MaintenanceReservation;
  readonly revision: number;
  readonly tokenDigest: string;
  readonly release: () => void;
  active: boolean;
}
const heldScopes = new WeakMap<object, HeldScopeEntry>();

/** Only the native owner can mint these entries; duck callbacks and JSON never grant. */
export function assertHeldPluginOperation(
  scope: HeldPluginOperationScope,
  expected: HeldPluginOperationClaim,
): void {
  const entry = heldScopes.get(scope);
  if (
    !entry ||
    !entry.active ||
    Object.keys(entry.claim).some(
      (key) =>
        entry.claim[key as keyof HeldPluginOperationClaim] !==
        expected[key as keyof HeldPluginOperationClaim],
    )
  )
    throw new Error("Invalid held plugin operation scope");
  entry.owner.assertHeldScopeCurrent(entry);
}

/** Single daemon event-loop admission lane. Acquiring a lease never yields. */
export class MaintenanceReservation {
  private record: RecordV1 | null = null;
  private recovery = false;
  private pending = false;
  private inFlight = 0;
  private activityRevision = 0;
  private readinessRevision = 0;
  private readonly leases = new WeakMap<() => void, { active: boolean }>();
  private failed = false;
  private readonly path: string;

  private transport?: { serverId: string; authority: QualifiedDaemonAccess };
  private pluginOperation?: HeldPluginOperationDriver;
  private ready = false;
  private revision = 0;
  private storageTail: Promise<void> = Promise.resolve();
  private enrolled = false;
  private attempt: { generation: number; transactionId: string } | null = null;
  private constructor(
    private readonly home: string,
    private readonly isQuiet: () => Promise<boolean>,
    private participant: PluginMaintenancePort = emptyMaintenanceParticipant,
  ) {
    this.path = join(home, "maintenance-reservation.json");
  }

  static async create(
    home: string,
    isQuiet: () => Promise<boolean>,
    participant: PluginMaintenancePort = emptyMaintenanceParticipant,
  ): Promise<MaintenanceReservation> {
    const reservation = new MaintenanceReservation(home, isQuiet, participant);
    await reservation.load();
    reservation.ready = true;
    return reservation;
  }

  private async load(): Promise<void> {
    const home = this.home;
    const enrollment = await readProtectedMaintenanceJson(home, "maintenance-enrollment.json");
    const stored = await readProtectedMaintenanceJson(home, "maintenance-reservation.json");
    if (
      JSON.stringify(enrollment) !==
      JSON.stringify(await readProtectedMaintenanceJson(home, "maintenance-enrollment.json"))
    )
      throw new Error("Maintenance enrollment changed");
    if (enrollment !== MISSING_MAINTENANCE_AUTHORITY) {
      validateMaintenanceEnrollment(enrollment);
      this.enrolled = true;
      if (stored === MISSING_MAINTENANCE_AUTHORITY)
        throw new Error("Established maintenance authority missing");
    } else if (stored !== MISSING_MAINTENANCE_AUTHORITY)
      throw new Error("Maintenance enrollment missing");
    if (stored !== MISSING_MAINTENANCE_AUTHORITY) {
      this.record = parseMaintenanceRecord(stored);
      this.recovery = Boolean(this.record.tokenDigest) || this.record.uncertain === true;
      this.failed = this.record.uncertain === true;
    }
  }

  holdForUnknownWork(): void {
    this.failed = true;
    this.recovery = true;
    this.revision++;
    let authority = this.record ?? {
      schemaVersion: 1 as const,
      generation: 0,
      transactionId: null,
      tokenDigest: null,
    };
    if (this.attempt && !this.record?.tokenDigest)
      authority = { schemaVersion: 1, ...this.attempt, tokenDigest: null };
    this.record = { ...authority, uncertain: true };
    // The synchronous latch closes admission immediately. The queued write is not
    // crash proof until its actual rename; callers awaiting an operation drain it.
    void this.storage(async () => {
      await this.enroll(true);
      await this.persist(this.record!, true);
    }).catch(() => {});
  }

  async flushStorage(): Promise<void> {
    await this.storageTail;
  }

  private storage<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.storageTail.then(operation);
    this.storageTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async enroll(uncertain = false): Promise<void> {
    if (this.enrolled) return;
    await this.writeAtomically(
      join(this.home, "maintenance-enrollment.json"),
      { schemaVersion: 1, component: "paseo-maintenance" },
      undefined,
      uncertain,
    );
    this.enrolled = true;
    await this.persist(
      this.record ?? { schemaVersion: 1, generation: 0, transactionId: null, tokenDigest: null },
      uncertain,
    );
  }

  bindTransport(
    serverId: string,
    authority: QualifiedDaemonAccess,
    operation?: HeldPluginOperationDriver,
  ): void {
    if (this.ready || this.pending)
      throw new Error("Maintenance transport must bind before startup");
    this.transport = { serverId, authority };
    this.pluginOperation = operation;
  }

  transportAuthority() {
    let daemonIncarnation: string | null = null;
    try {
      daemonIncarnation = this.transport?.authority.incarnation() ?? null;
    } catch {
      /* Unsupported owner never yields qualified metadata. */
    }
    const qualified = daemonIncarnation !== null;
    const supported = qualified && this.isReady();
    return {
      schemaVersion: 1 as const,
      serverId: this.transport?.serverId ?? "",
      daemonIncarnation,
      qualified,
      features: {
        maintenanceReservationV1: supported,
        maintenancePluginOperationV1: supported && this.pluginOperation !== undefined,
      },
    };
  }

  supportsPluginOperations(): boolean {
    return this.transportAuthority().features.maintenancePluginOperationV1;
  }

  assertTransport(
    input: {
      expectedServerId?: string;
      expectedDaemonIncarnation?: string;
      transactionId?: string;
    },
    end = false,
  ): void {
    if (input.expectedServerId !== undefined || input.expectedDaemonIncarnation !== undefined) {
      const actual = this.transportAuthority();
      if (
        !actual.qualified ||
        input.expectedServerId !== actual.serverId ||
        input.expectedDaemonIncarnation !== actual.daemonIncarnation
      )
        throw new Error("Maintenance transport identity mismatch");
    }
    if (
      end &&
      input.transactionId !== undefined &&
      input.transactionId !== this.record?.transactionId
    )
      throw new Error("Maintenance transaction mismatch");
  }

  async executePluginOperation(
    input: HeldPluginOperationClaim & {
      ownerToken: string;
      expectedServerId: string;
      expectedDaemonIncarnation: string;
    },
  ) {
    this.assertTransport(input);
    const driver = this.pluginOperation;
    if (!driver || !this.supportsPluginOperations())
      throw new Error("Held plugin operation unsupported");
    if (
      !isAbsolute(input.path) ||
      resolve(input.path) !== input.path ||
      !isAbsolute(input.expectedPath) ||
      resolve(input.expectedPath) !== input.expectedPath ||
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 0 ||
      !/^[a-f0-9]{64}$/.test(input.snapshotSha256) ||
      !/^[a-f0-9]{64}$/.test(input.serverBundleSha256)
    )
      throw new Error("Invalid held plugin operation target");
    // Copy only public claim fields; bearer and transport metadata never reach the driver.
    const claim: HeldPluginOperationClaim = {
      generation: input.generation,
      transactionId: input.transactionId,
      operation: input.operation,
      pluginId: input.pluginId,
      path: input.path,
      expectedPath: input.expectedPath,
      expectedGeneration: input.expectedGeneration,
      snapshotSha256: input.snapshotSha256,
      serverBundleSha256: input.serverBundleSha256,
    };
    return this.ownerPluginOperation(claim, input.ownerToken, async (scope) => {
      const result = await driver(claim, scope);
      this.assertTransport(input);
      assertHeldPluginOperation(scope, claim);
      assertHeldPluginOperationResult(claim, result);
      const authority = this.transportAuthority();
      if (!authority.qualified || !authority.daemonIncarnation)
        throw new Error("Maintenance owner unavailable");
      return {
        ...result,
        maintenance: { ...this.status(), authority },
        serverId: authority.serverId,
        daemonIncarnation: authority.daemonIncarnation,
      };
    });
  }

  isReady(): boolean {
    try {
      return this.ready && this.participant.supportsV1() === true;
    } catch {
      return false;
    }
  }

  bindParticipant(participant: PluginMaintenancePort): void {
    if (this.ready || this.pending)
      throw new Error("Maintenance participant must bind before startup");
    this.participant = participant;
  }

  hasPersistedHold(): boolean {
    return Boolean(this.record?.tokenDigest || this.record?.uncertain);
  }

  private heldIdentity(): MaintenanceIdentity | null {
    if (!this.hasPersistedHold()) return null;
    if (!this.record || this.record.generation <= 0 || !this.record.transactionId)
      throw new Error("Unowned maintenance recovery requires operator");
    return { generation: this.record.generation, transactionId: this.record.transactionId };
  }

  async restoreParticipantBeforeStart(): Promise<void> {
    const identity = this.heldIdentity();
    if (!identity) return;
    const result = await (this.participant.restoreBeforeStart?.(identity) ??
      this.participant.begin(identity));
    if (result === "known-busy")
      throw new Error("Cannot restore maintenance barrier before startup");
    // Unknown retains parent admission closed; only the participant's independently
    // qualified passive initialization may run next. Missing port never reaches here.
  }

  async recheckRestoredParticipant(): Promise<void> {
    const identity = this.heldIdentity();
    if (!identity) return;
    try {
      const result = await this.participant.begin(identity);
      if (result === "unknown") {
        this.failed = true;
        this.recovery = true;
      }
      // Known busy keeps the existing hold and admitted initialization alive.
    } catch {
      this.failed = true;
      this.recovery = true;
    }
  }

  async runQualifiedInitialization<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.hasPersistedHold() ? this.lease() : this.enter();
    // Only bootstrap's protected-qualification bridge calls this. The participant
    // owns actual initialization/helper accounting; the resident transport is not work.
    try {
      return await executionOwner.run(undefined, operation);
    } finally {
      release();
    }
  }
  setReady(ready: boolean): void {
    if (this.ready !== ready) this.readinessRevision++;
    this.ready = ready;
  }

  enter(): () => void {
    if (this.failed || this.pending || this.record?.tokenDigest)
      throw new Error("Daemon maintenance admission held");
    return this.lease();
  }

  private lease(): () => void {
    this.activityRevision++;
    this.inFlight++;
    const state = { active: true };
    const release = () => {
      if (state.active) {
        state.active = false;
        this.inFlight--;
      }
    };
    this.leases.set(release, state);
    return release;
  }

  enterProcess(): () => void {
    const scope = executionOwner.getStore();
    // A real already-admitted continuation may finish under a provisional/uncertain
    // barrier. Expired async scopes cannot revive work after every owning lease ends.
    if (scope?.owner === this && scope.leases.some((release) => this.leases.get(release)?.active))
      return this.lease();
    return this.enter();
  }

  executeAdmitted<T>(release: () => void, operation: () => T): T {
    if (!this.leases.get(release)?.active) throw new Error("Expired maintenance activity lease");
    const current = executionOwner.getStore();
    return executionOwner.run(
      { owner: this, leases: [release, ...(current?.owner === this ? current.leases : [])] },
      operation,
    );
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.enter();
    try {
      return await this.executeAdmitted(release, operation);
    } finally {
      release();
    }
  }

  async runCleanup<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.lease();
    try {
      return await executionOwner.run(undefined, operation);
    } finally {
      release();
    }
  }

  execute<T>(operation: () => T): T {
    const current = executionOwner.getStore();
    return executionOwner.run(
      current?.owner === this ? current : { owner: this, leases: [] },
      operation,
    );
  }

  status(): MaintenanceStatus {
    const recoveryRequired = this.failed || this.recovery;
    const closed = this.pending || recoveryRequired || Boolean(this.record?.tokenDigest);
    let state: MaintenanceStatus["state"] = "idle";
    if (closed) state = "held";
    if (recoveryRequired) state = "recovery-required";
    return {
      schemaVersion: 1,
      reservationGeneration: this.record?.generation ?? 0,
      ready: this.isReady(),
      state,
      generation: this.attempt?.generation ?? (this.record?.generation || null),
      transactionId: this.attempt?.transactionId ?? this.record?.transactionId ?? null,
      recoveryRequired,
    };
  }

  private assertNoUnknownWork(): void {
    if (this.failed) throw new Error("Maintenance activity became unknown");
  }

  private async prepareParticipant(identity: MaintenanceIdentity): Promise<boolean> {
    const initial = await this.participant.begin(identity);
    this.assertNoUnknownWork();
    if (initial === "known-busy") {
      // Only a confirmed qualified rollback can discard an unpublished attempt.
      await this.participant.end(identity);
      this.assertNoUnknownWork();
      return false;
    }
    if (initial !== "held") throw new Error("Unknown plugin maintenance barrier");
    const quiet = await this.isQuiet();
    this.assertNoUnknownWork();
    if (quiet !== true && quiet !== false) throw new Error("Unknown maintenance observation");
    if (!quiet || this.inFlight) {
      await this.participant.end(identity);
      this.assertNoUnknownWork();
      return false;
    }
    // Recheck current policy, cohort and incarnation after authoritative awaits.
    const rechecked = await this.participant.begin(identity);
    this.assertNoUnknownWork();
    if (rechecked === "known-busy") {
      await this.participant.end(identity);
      this.assertNoUnknownWork();
      return false;
    }
    if (rechecked !== "held" || !this.participant.supportsV1() || this.inFlight)
      throw new Error("Plugin maintenance cohort changed or unknown");
    this.assertNoUnknownWork();
    return true;
  }

  private persistenceAuthority(
    previous: RecordV1 | null,
    next: RecordV1,
    identity: MaintenanceIdentity,
  ): (committed: boolean) => void {
    const readinessRevision = this.readinessRevision;
    const activityRevision = this.activityRevision;
    return (committed) => {
      this.assertNoUnknownWork();
      if (!this.pending || !this.isReady()) throw new Error("Maintenance authority not ready");
      // Check after the synchronous participant/producer assertions as well. No
      // async preparation may replace the sampled owner or admit even completed cleanup.
      this.assertNoUnknownWork();
      if (
        !this.ready ||
        this.readinessRevision !== readinessRevision ||
        this.inFlight ||
        this.activityRevision !== activityRevision
      )
        throw new Error("Maintenance work or readiness changed during persistence");
      if (
        this.record !== (committed ? next : previous) ||
        next.generation !== identity.generation ||
        next.transactionId !== identity.transactionId
      )
        throw new Error("Maintenance persistence ownership changed");
    };
  }

  private assertBeginRequest(generation: number, transactionId: string): void {
    if (
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      !transactionId ||
      transactionId.length > 256
    )
      throw new Error("Invalid maintenance transaction");
    if (
      this.failed ||
      this.pending ||
      this.record?.tokenDigest ||
      this.record?.uncertain ||
      this.recovery ||
      generation <= (this.record?.generation ?? 0)
    )
      throw new Error("Maintenance busy or stale generation");
  }

  async begin(
    generation: number,
    transactionId: string,
  ): Promise<MaintenanceStatus & { ownerToken: string }> {
    this.assertBeginRequest(generation, transactionId);
    let previous = this.record;
    const readinessRevision = this.readinessRevision;
    const assertAvailable = () => {
      this.assertNoUnknownWork();
      if (!this.isReady())
        throw new Error("Maintenance reservation unsupported or startup incomplete");
      this.assertNoUnknownWork();
      if (
        !this.ready || this.readinessRevision !== readinessRevision ||
        this.record !== previous || this.record?.tokenDigest || this.record?.uncertain ||
        this.recovery || generation <= (this.record?.generation ?? 0)
      ) throw new Error("Maintenance authority changed");
    };
    assertAvailable();
    // No barrier or authority transition has occurred. Never acquire over admitted work.
    if (this.inFlight) throw knownBusyRefusal();
    const identity = { generation, transactionId };
    this.pending = true;
    this.attempt = identity;
    let knownBusy = false;
    try {
      await this.storage(() => this.enroll());
      this.assertNoUnknownWork();
      if (previous === null && this.record?.generation === 0 && !this.record.tokenDigest &&
        this.record.transactionId === null) previous = this.record;
      const prepared = await this.prepareParticipant(identity);
      assertAvailable();
      if (!this.pending || this.attempt !== identity)
        throw new Error("Maintenance attempt changed");
      if (!prepared) {
        // prepareParticipant returned only after every provisional barrier acknowledged rollback.
        knownBusy = true;
        throw knownBusyRefusal();
      }
      this.assertNoUnknownWork();
      const ownerToken = randomBytes(32).toString("base64url");
      const next: RecordV1 = {
        schemaVersion: 1,
        generation,
        transactionId,
        tokenDigest: digest(ownerToken),
      };
      const validate = this.persistenceAuthority(this.record, next, identity);
      await this.storage(() => this.persist(next, false, validate));
      validate(true);
      this.recovery = false;
      this.pending = false;
      return { ...this.status(), ownerToken };
    } catch (error) {
      if (!knownBusy) {
        if (!this.failed) this.holdForUnknownWork();
        await this.storageTail;
        // Unknown never releases a possibly established participant barrier.
      }
      throw error;
    } finally {
      this.pending = false;
      if (!this.failed) this.attempt = null;
    }
  }

  async end(generation: number, ownerToken: string): Promise<MaintenanceStatus> {
    const record = this.record;
    const expected = record?.tokenDigest;
    // Authenticate before any participant call; token is never forwarded.
    if (
      this.failed ||
      this.pending ||
      this.inFlight ||
      !record ||
      !expected ||
      generation !== record.generation ||
      !record.transactionId ||
      !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(digest(ownerToken), "hex"))
    )
      throw new Error("Maintenance ownership mismatch or busy");
    if (!this.isReady())
      throw new Error("Maintenance participant unsupported or initialization incomplete");
    const identity = { generation, transactionId: record.transactionId };
    this.pending = true;
    let knownBusy = false;
    try {
      const fresh = await this.participant.begin(identity);
      this.assertNoUnknownWork();
      if (fresh === "known-busy" || this.inFlight || !this.ready) {
        knownBusy = true;
        throw new Error("Maintenance known busy");
      }
      if (fresh !== "held" || !this.participant.supportsV1())
        throw new Error("Maintenance participant not safely held");
      this.assertNoUnknownWork();
      const next: RecordV1 = { ...record, tokenDigest: null };
      const validate = this.persistenceAuthority(record, next, identity);
      await this.storage(() => this.persist(next, false, validate));
      validate(true);
      await this.participant.end(identity);
      validate(true);
      this.recovery = false;
    } catch (error) {
      if (!knownBusy) {
        this.failed = true;
        this.recovery = true;
      }
      await this.storageTail;
      // The stable idle rename remains authorized release on restart. No automatic
      // rollback, bearer replay, participant END retry or second journal is introduced.
      throw error;
    } finally {
      this.pending = false;
    }
    return this.status();
  }

  assertHeldScopeCurrent(entry: HeldScopeEntry): void {
    if (
      entry.owner !== this ||
      this.failed ||
      !this.isReady() ||
      this.revision !== entry.revision ||
      !this.leases.get(entry.release)?.active ||
      this.record?.tokenDigest !== entry.tokenDigest ||
      this.record.generation !== entry.claim.generation ||
      this.record.transactionId !== entry.claim.transactionId
    )
      throw new Error("Expired held plugin operation authority");
  }

  runHeldOperation<T>(
    scope: HeldPluginOperationScope,
    expected: HeldPluginOperationClaim,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertHeldPluginOperation(scope, expected);
    const entry = heldScopes.get(scope)!;
    if (entry.owner !== this) throw new Error("Wrong native maintenance owner");
    return this.executeAdmitted(entry.release, operation);
  }

  async ownerPluginOperation<T>(
    claim: HeldPluginOperationClaim,
    ownerToken: string,
    operation: (scope: HeldPluginOperationScope) => Promise<T>,
  ): Promise<T> {
    const record = this.record;
    if (
      this.failed ||
      this.pending ||
      this.inFlight ||
      !record?.tokenDigest ||
      record.generation !== claim.generation ||
      record.transactionId !== claim.transactionId ||
      !timingSafeEqual(
        Buffer.from(record.tokenDigest, "hex"),
        Buffer.from(digest(ownerToken), "hex"),
      )
    )
      throw new Error("Maintenance ownership mismatch or busy");
    if (!this.isReady()) throw new Error("Maintenance participant unsupported");
    const release = this.lease();
    const scope = Object.freeze({}) as HeldPluginOperationScope;
    const entry: HeldScopeEntry = {
      claim: Object.freeze({ ...claim }),
      owner: this,
      revision: this.revision,
      tokenDigest: record.tokenDigest,
      release,
      active: true,
    };
    heldScopes.set(scope, entry);
    try {
      const held = await this.participant.begin({
        generation: claim.generation,
        transactionId: claim.transactionId,
      });
      assertHeldPluginOperation(scope, claim);
      if (held !== "held" || !this.isReady())
        throw new Error("Maintenance operation cohort unavailable");
      const result = await this.executeAdmitted(release, () => operation(scope));
      assertHeldPluginOperation(scope, claim);
      const successor = await this.participant.begin({
        generation: claim.generation,
        transactionId: claim.transactionId,
      });
      assertHeldPluginOperation(scope, claim);
      if (successor !== "held" || !this.isReady())
        throw new Error("Maintenance successor not safely held");
      return result;
    } catch (error) {
      this.holdForUnknownWork();
      await this.storageTail;
      throw error;
    } finally {
      entry.active = false;
      release();
    }
  }

  private persist(
    record: RecordV1,
    uncertain = false,
    validate?: (committed: boolean) => void,
  ): Promise<void> {
    return this.writeAtomically(
      this.path,
      record,
      () => {
        this.record = record;
      },
      uncertain,
      validate,
    );
  }

  private async writeAtomically(
    path: string,
    value: unknown,
    committed?: () => void,
    uncertain = false,
    validate?: (committed: boolean) => void,
  ): Promise<void> {
    const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    const revision = this.revision;
    let file: FileHandle | undefined;
    let directory: FileHandle | undefined;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify(value));
      await file.sync();
      await file.close();
      file = undefined;
      // The only synchronous IO: accepted actual-rename commit point. No yield
      // between final revision/latch check, rename and committed-state update.
      if (revision !== this.revision || (!uncertain && this.failed))
        throw new Error("Maintenance activity became unknown before commit");
      validate?.(false);
      renameSync(temporary, path);
      committed?.();
      directory = await open(this.home, "r");
      await directory.sync();
      await directory.close();
      directory = undefined;
      if (!uncertain) this.assertNoUnknownWork();
      validate?.(true);
    } catch (error) {
      this.failed = true;
      this.recovery = true;
      if (file) await file.close().catch(() => {});
      if (directory) await directory.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

/** Install on the shared owner, before handing it to any internal or transport caller. */
export function guardMaintenanceMethod<T extends object, K extends keyof T>(
  owner: T,
  key: K,
  reservation: MaintenanceReservation,
): void {
  owners.set(owner, reservation);
  const operation = owner[key] as (...args: unknown[]) => Promise<unknown>;
  owner[key] = ((...args: unknown[]) =>
    reservation.run(() => operation.apply(owner, args))) as T[K];
}

export function guardMaintenanceStream<T extends object, K extends keyof T>(
  owner: T,
  key: K,
  reservation: MaintenanceReservation,
): void {
  owners.set(owner, reservation);
  const operation = owner[key] as (...args: unknown[]) => AsyncGenerator<unknown>;
  owner[key] = async function* (...args: unknown[]) {
    const release = reservation.enter();
    try {
      const iterator = operation.apply(owner, args);
      yield* {
        [Symbol.asyncIterator]() {
          return {
            next: (value?: unknown) =>
              reservation.executeAdmitted(release, () => iterator.next(value)),
            return: (value?: unknown) =>
              reservation.executeAdmitted(release, () => iterator.return(value)),
            throw: (error?: unknown) =>
              reservation.executeAdmitted(release, () => iterator.throw(error)),
          };
        },
      };
    } finally {
      release();
    }
  } as T[K];
}

const owners = new WeakMap<object, MaintenanceReservation>();
export function maintenanceFor(
  owner: object | null | undefined,
): MaintenanceReservation | undefined {
  return owner ? owners.get(owner) : undefined;
}
