import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MaintenanceStatus {
  schemaVersion: 1;
  state: "idle" | "held" | "recovery-required";
  generation: number | null;
  transactionId: string | null;
  recoveryRequired: boolean;
}
interface RecordV1 {
  schemaVersion: 1;
  generation: number;
  transactionId: string;
  tokenDigest: string | null;
}
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** Single daemon event-loop admission lane. Acquiring a lease never yields. */
export class MaintenanceReservation {
  private record: RecordV1 | null = null;
  private recovery = false;
  private pending = false;
  private inFlight = 0;
  private failed = false;
  private readonly path: string;

  constructor(home: string, private readonly isQuiet: () => Promise<boolean>) {
    this.path = join(home, "maintenance-reservation.json");
    if (existsSync(this.path)) {
      const metadata = lstatSync(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
          (metadata.mode & 0o077) || (process.getuid && metadata.uid !== process.getuid())) {
        throw new Error("Unprotected maintenance record; admission unavailable");
      }
      const value = JSON.parse(readFileSync(this.path, "utf8")) as RecordV1;
      if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || value.generation <= 0 ||
          typeof value.transactionId !== "string" || !value.transactionId ||
          !(value.tokenDigest === null || (typeof value.tokenDigest === "string" && /^[a-f0-9]{64}$/.test(value.tokenDigest)))) {
        throw new Error("Invalid maintenance reservation; admission unavailable");
      }
      this.record = value;
      this.recovery = value.tokenDigest !== null;
    }
  }

  enter(): () => void {
    if (this.failed || this.pending || this.record?.tokenDigest) throw new Error("Daemon maintenance admission held");
    this.inFlight++;
    let released = false;
    return () => { if (!released) { released = true; this.inFlight--; } };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.enter();
    try { return await operation(); } finally { release(); }
  }

  status(): MaintenanceStatus {
    const held = Boolean(this.record?.tokenDigest);
    return { schemaVersion: 1, state: held ? (this.recovery ? "recovery-required" : "held") : "idle",
      generation: this.record?.generation ?? null, transactionId: this.record?.transactionId ?? null,
      recoveryRequired: held && this.recovery };
  }

  async begin(generation: number, transactionId: string): Promise<MaintenanceStatus & { ownerToken: string }> {
    if (!Number.isSafeInteger(generation) || generation <= 0 || !transactionId || transactionId.length > 256)
      throw new Error("Invalid maintenance transaction");
    if (this.failed || this.pending || this.record?.tokenDigest || this.inFlight || generation <= (this.record?.generation ?? 0))
      throw new Error("Maintenance busy or stale generation");
    // Close admission BEFORE asynchronous observation; entrants cannot race the snapshot.
    this.pending = true;
    try {
      if (!(await this.isQuiet()) || this.inFlight) throw new Error("Maintenance busy or unknown work");
      const ownerToken = randomBytes(32).toString("base64url");
      this.persist({ schemaVersion: 1, generation, transactionId, tokenDigest: digest(ownerToken) });
      this.recovery = false;
      return { ...this.status(), ownerToken };
    } finally { this.pending = false; }
  }

  end(generation: number, ownerToken: string): MaintenanceStatus {
    const record = this.record;
    const expected = record?.tokenDigest;
    if (this.failed || this.pending || !record || !expected || generation !== record.generation ||
        !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(digest(ownerToken), "hex")))
      throw new Error("Maintenance ownership mismatch");
    this.persist({ ...record, tokenDigest: null });
    this.recovery = false;
    return this.status();
  }

  private persist(record: RecordV1): void {
    const temporary = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); }
    finally { closeSync(fd); }
    // After a rename error admission remains closed until explicit recovery.
    try {
      renameSync(temporary, this.path);
      this.record = record;
      const directory = openSync(join(this.path, ".."), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      this.failed = true;
      this.record = record;
      this.recovery = true;
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
}

/** Install on the shared owner, before handing it to any internal or transport caller. */
export function guardMaintenanceMethod<T extends object, K extends keyof T>(
  owner: T, key: K, reservation: MaintenanceReservation,
): void {
  owners.set(owner, reservation);
  const operation = owner[key] as (...args: unknown[]) => Promise<unknown>;
  owner[key] = ((...args: unknown[]) => reservation.run(() => operation.apply(owner, args))) as T[K];
}

export function guardMaintenanceStream<T extends object, K extends keyof T>(
  owner: T, key: K, reservation: MaintenanceReservation,
): void {
  owners.set(owner, reservation);
  const operation = owner[key] as (...args: unknown[]) => AsyncGenerator<unknown>;
  owner[key] = (async function* (...args: unknown[]) {
    const release = reservation.enter();
    try { yield* operation.apply(owner, args); } finally { release(); }
  }) as T[K];
}

const owners = new WeakMap<object, MaintenanceReservation>();
export function maintenanceFor(owner: object | null | undefined): MaintenanceReservation | undefined {
  return owner ? owners.get(owner) : undefined;
}
