import { AsyncLocalStorage } from "node:async_hooks";
import {
  MISSING_MAINTENANCE_AUTHORITY,
  readProtectedMaintenanceJson,
  parseMaintenanceRecord,
  validateMaintenanceEnrollment,
  type MaintenanceRecord,
} from "./maintenance-offline.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MaintenanceStatus {
  schemaVersion: 1;
  state: "idle" | "held" | "recovery-required";
  generation: number | null;
  transactionId: string | null;
  recoveryRequired: boolean;
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

/** Single daemon event-loop admission lane. Acquiring a lease never yields. */
export class MaintenanceReservation {
  private record: RecordV1 | null = null;
  private recovery = false;
  private pending = false;
  private inFlight = 0;
  private readonly leases = new WeakMap<() => void, { active: boolean }>();
  private failed = false;
  private readonly path: string;

  private ready = true;
  private enrolled = false;
  private attempt: { generation: number; transactionId: string } | null = null;
  constructor(
    private readonly home: string,
    private readonly isQuiet: () => Promise<boolean>,
  ) {
    this.path = join(home, "maintenance-reservation.json");
    const enrollment = readProtectedMaintenanceJson(home, "maintenance-enrollment.json");
    const stored = readProtectedMaintenanceJson(home, "maintenance-reservation.json");
    if (
      JSON.stringify(enrollment) !==
      JSON.stringify(readProtectedMaintenanceJson(home, "maintenance-enrollment.json"))
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
    this.enroll();
    this.persist({
      ...(this.record ?? {
        schemaVersion: 1,
        generation: 0,
        transactionId: null,
        tokenDigest: null,
      }),
      uncertain: true,
    });
  }

  private enroll(): void {
    if (this.enrolled) return;
    this.writeAtomically(join(this.home, "maintenance-enrollment.json"), {
      schemaVersion: 1,
      component: "paseo-maintenance",
    });
    this.enrolled = true;
    this.persist({ schemaVersion: 1, generation: 0, transactionId: null, tokenDigest: null });
  }

  isReady(): boolean {
    return this.ready;
  }
  setReady(ready: boolean): void {
    this.ready = ready;
  }

  enter(): () => void {
    if (this.failed || this.pending || this.record?.tokenDigest)
      throw new Error("Daemon maintenance admission held");
    return this.lease();
  }

  private lease(): () => void {
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
    return {
      schemaVersion: 1,
      state: recoveryRequired ? "recovery-required" : closed ? "held" : "idle",
      generation: this.attempt?.generation ?? (this.record?.generation || null),
      transactionId: this.attempt?.transactionId ?? this.record?.transactionId ?? null,
      recoveryRequired,
    };
  }

  async begin(
    generation: number,
    transactionId: string,
  ): Promise<MaintenanceStatus & { ownerToken: string }> {
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
      this.inFlight ||
      generation <= (this.record?.generation ?? 0)
    )
      throw new Error("Maintenance busy or stale generation");
    if (!this.ready) throw new Error("Maintenance startup not ready");
    this.pending = true;
    this.attempt = { generation, transactionId };
    let knownBusy = false;
    try {
      this.enroll();
      let quiet: boolean;
      try {
        quiet = await this.isQuiet();
        if (quiet !== true && quiet !== false) throw new Error("Unknown maintenance observation");
      } catch (error) {
        this.failed = true;
        this.recovery = true;
        this.persist({
          schemaVersion: 1,
          generation,
          transactionId,
          tokenDigest: null,
          uncertain: true,
        });
        throw error;
      }
      if (!quiet || this.inFlight) {
        knownBusy = true;
        throw new Error("Maintenance known busy");
      }
      const ownerToken = randomBytes(32).toString("base64url");
      this.persist({
        schemaVersion: 1,
        generation,
        transactionId,
        tokenDigest: digest(ownerToken),
      });
      this.recovery = false;
      this.pending = false;
      return { ...this.status(), ownerToken };
    } catch (error) {
      if (!knownBusy) {
        this.failed = true;
        this.recovery = true;
      }
      throw error;
    } finally {
      this.pending = false;
      if (!this.failed) this.attempt = null;
    }
  }

  end(generation: number, ownerToken: string): MaintenanceStatus {
    const record = this.record;
    const expected = record?.tokenDigest;
    if (
      this.failed ||
      this.pending ||
      !record ||
      !expected ||
      generation !== record.generation ||
      !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(digest(ownerToken), "hex"))
    )
      throw new Error("Maintenance ownership mismatch");
    this.persist({ ...record, tokenDigest: null });
    this.recovery = false;
    return this.status();
  }

  private persist(record: RecordV1): void {
    this.writeAtomically(this.path, record, () => {
      this.record = record;
    });
  }

  private writeAtomically(path: string, value: unknown, committed?: () => void): void {
    const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    let fd: number | null = null;
    let directory: number | null = null;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temporary, path);
      committed?.(); // Logical commit: an idle tombstone follows owner-authorized release.
      directory = openSync(this.home, "r");
      fsyncSync(directory);
      closeSync(directory);
      directory = null;
    } catch (error) {
      this.failed = true;
      this.recovery = true;
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
      if (directory !== null) {
        try {
          closeSync(directory);
        } catch {}
      }
      try {
        unlinkSync(temporary);
      } catch {}
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
