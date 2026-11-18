import type { ChildProcess, SpawnOptions } from "node:child_process";
import { AsyncResource, AsyncLocalStorage } from "node:async_hooks";

export interface PluginBarrierIdentity {
  generation: number;
  transactionId: string;
  instanceId: string;
}
export type PluginBarrierState = "held" | "known-busy" | "unknown";
interface ActivityLease {
  owner: PluginActivityOwner;
  resource: AsyncResource;
  references: number;
  allowHelpers: boolean;
  onSettled: () => void;
}
const activityScope = new AsyncLocalStorage<ActivityLease>();
export interface PluginHelperOperation {
  readonly kind: "spawn" | "execFile";
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Readonly<SpawnOptions> & {
    readonly encoding?: string | null;
    readonly maxBuffer?: number;
  };
}
export interface PluginHelperAdmissionRequest {
  readonly activityOwner: PluginActivityOwner | undefined;
  readonly root: object | undefined;
  readonly operation: PluginHelperOperation;
}
export interface PluginHelperAdmissionPermit {
  readonly settled: Promise<void>;
  bind(child: ChildProcess): void;
  failed(error: unknown): void;
}
export interface PluginHelperLease {
  bind(child: ChildProcess): void;
  failed(error: unknown): void;
  release(): void;
}
const originalActivityRoots = new WeakSet<object>();
let qualifiedHelperAdmission:
  | ((request: PluginHelperAdmissionRequest) => PluginHelperAdmissionPermit | void)
  | undefined;

/** Trusted sealed startup installs this before any candidate code; it can never be replaced. */
export function installQualifiedHelperAdmission(
  guard: (request: PluginHelperAdmissionRequest) => PluginHelperAdmissionPermit | void,
): void {
  if (qualifiedHelperAdmission) throw new Error("Qualified helper admission is already installed");
  if (typeof guard !== "function") throw new Error("Qualified helper admission requires a guard");
  qualifiedHelperAdmission = guard;
}

/** Execution-owner accounting: callers timing out or aborting never settle these leases. */
export class PluginActivityOwner {
  private barrier: PluginBarrierIdentity | null = null;
  private activity = 0;
  private uncertain = false;
  private passive = false;
  private readonly onUnknown: () => void;
  constructor(onUnknown: () => void = () => {}) {
    this.onUnknown = onUnknown;
  }
  assertLiveRoot(root: object): void {
    if (!originalActivityRoots.has(root)) throw new Error("Unknown plugin activity root");
    const lease = root as ActivityLease;
    if (lease.owner !== this || lease.references <= 0)
      throw new Error("Expired plugin activity root");
  }
  qualifyPassive(): void {
    this.passive = true;
  }

  begin(identity: PluginBarrierIdentity): PluginBarrierState {
    if (this.barrier && !sameBarrier(this.barrier, identity)) return "unknown";
    this.barrier = { ...identity };
    return this.state();
  }
  end(identity: PluginBarrierIdentity): void {
    if (!this.barrier || !sameBarrier(this.barrier, identity) || this.uncertain)
      throw new Error("Plugin barrier release identity/state mismatch");
    this.barrier = null;
  }
  state(): PluginBarrierState {
    if (this.uncertain) return "unknown";
    return this.activity > 0 ? "known-busy" : "held";
  }
  markUnknown(): void {
    if (this.uncertain) return;
    this.uncertain = true;
    this.onUnknown();
  }
  acquire(onSettled: () => void = () => {}): PluginActivityLease {
    if (this.barrier || this.uncertain) throw new Error("Plugin maintenance admission is closed");
    return this.makeLease(true, onSettled);
  }
  initialization(): PluginActivityLease {
    if (this.uncertain) throw new Error("Plugin initialization activity is uncertain");
    return this.makeLease(false, () => {});
  }
  retainCurrent(): PluginActivityLease {
    const lease = activityScope.getStore();
    if (!lease || lease.owner !== this || lease.references === 0)
      throw new Error("Missing live plugin activity lease");
    lease.references++;
    this.activity++;
    let released = false;
    return {
      run: (task) => lease.resource.runInAsyncScope(() => activityScope.run(lease, task)),
      release: () => {
        if (released) return;
        released = true;
        this.release(lease);
      },
    };
  }
  private makeLease(allowHelpers: boolean, onSettled: () => void): PluginActivityLease {
    const lease: ActivityLease = {
      owner: this,
      resource: new AsyncResource("paseo.plugin.activity"),
      references: 1,
      allowHelpers,
      onSettled,
    };
    originalActivityRoots.add(lease);
    this.activity++;
    let released = false;
    return {
      run: (task) => lease.resource.runInAsyncScope(() => activityScope.run(lease, task)),
      release: () => {
        if (released) return;
        released = true;
        this.release(lease);
      },
    };
  }
  helper(lease: ActivityLease): () => void {
    if (!lease.allowHelpers) throw new Error("Passive initialization cannot launch helpers");
    if (lease.references === 0) {
      if (this.passive) throw new Error("Settled plugin activity cannot admit a helper");
      return () => {};
    }
    lease.references++;
    this.activity++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(lease);
    };
  }
  private release(lease: ActivityLease): void {
    lease.references--;
    this.activity--;
    if (lease.references === 0) {
      lease.resource.emitDestroy();
      lease.onSettled();
    }
  }
}
export interface PluginActivityLease {
  run<T>(task: () => T): T;
  release(): void;
}
export function acquirePluginHelper(operation: PluginHelperOperation): PluginHelperLease {
  const lease = activityScope.getStore();
  const admission = qualifiedHelperAdmission?.({
    activityOwner: lease?.owner,
    root: lease,
    operation,
  });
  const permit = admission ? admission : undefined;
  let release: () => void;
  try {
    release = lease ? lease.owner.helper(lease) : () => {};
  } catch (error) {
    permit?.failed(error);
    throw error;
  }
  let released = false;
  let failed = false;
  let bound = false;
  let leaderClosed = false;
  let settled = permit === undefined;
  const releaseActual = () => {
    if (!released && leaderClosed && settled) {
      released = true;
      release();
    }
  };
  if (permit)
    void permit.settled.then(
      () => {
        settled = true;
        releaseActual();
        return undefined;
      },
      (error) => {
        lease?.owner.markUnknown();
        permit.failed(error);
        return undefined;
      },
    );
  return {
    bind(child) {
      if (bound || released) throw new Error("Plugin helper handle already bound or settled");
      bound = true;
      permit?.bind(child);
    },
    failed(error) {
      if (failed) return;
      failed = true;
      permit?.failed(error);
    },
    release() {
      leaderClosed = true;
      releaseActual();
    },
  };
}
function sameBarrier(left: PluginBarrierIdentity, right: PluginBarrierIdentity): boolean {
  return (
    left.generation === right.generation &&
    left.transactionId === right.transactionId &&
    left.instanceId === right.instanceId
  );
}

export function bindPluginActivity<T>(task: () => T): () => T {
  const lease = activityScope.getStore();
  return lease ? () => lease.resource.runInAsyncScope(() => activityScope.run(lease, task)) : task;
}
