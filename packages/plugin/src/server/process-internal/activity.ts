import { AsyncLocalStorage } from "node:async_hooks";

export interface PluginBarrierIdentity {
  generation: number;
  transactionId: string;
  instanceId: string;
}
export type PluginBarrierState = "held" | "known-busy" | "unknown";
interface ActivityLease {
  owner: PluginActivityOwner;
  references: number;
  allowHelpers: boolean;
  onSettled: () => void;
}
const activityScope = new AsyncLocalStorage<ActivityLease>();

/** Execution-owner accounting: callers timing out or aborting never settle these leases. */
export class PluginActivityOwner {
  private barrier: PluginBarrierIdentity | null = null;
  private activity = 0;
  private uncertain = false;
  private passive = false;
  constructor(private readonly onUnknown: () => void = () => {}) {}
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
      run: (task) => activityScope.run(lease, task),
      release: () => {
        if (released) return;
        released = true;
        this.release(lease);
      },
    };
  }
  private makeLease(allowHelpers: boolean, onSettled: () => void): PluginActivityLease {
    const lease: ActivityLease = { owner: this, references: 1, allowHelpers, onSettled };
    this.activity++;
    let released = false;
    return {
      run: (task) => activityScope.run(lease, task),
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
    if (lease.references === 0) lease.onSettled();
  }
}
export interface PluginActivityLease {
  run<T>(task: () => T): T;
  release(): void;
}
export function acquirePluginHelper(): () => void {
  const lease = activityScope.getStore();
  return lease ? lease.owner.helper(lease) : () => {};
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
  return lease ? () => activityScope.run(lease, task) : task;
}
