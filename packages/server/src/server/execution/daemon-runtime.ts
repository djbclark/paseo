import { attachQualifiedDaemonMeasurement } from "./daemon-measurement.js";
import { readFixedManagedPluginPolicy } from "./managed-policy-environment.js";
import { ManagedPluginPolicySchema } from "../plugins/activation-policy.js";
import { getQualifiedDaemonOwner } from "./daemon-owner.js";
import {
  createPaseoDaemon,
  formatListenTarget,
  type PaseoDaemonDependencies,
} from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { createRootLogger } from "../logger.js";
import { resolvePaseoHome } from "../paseo-home.js";
import { acquireQualifiedDaemonReadiness } from "./daemon-readiness.js";

function throwStartupFailure(error: unknown, cleanup: readonly unknown[]): never {
  if (cleanup.length)
    throw new AggregateError([error, ...cleanup], "Daemon startup and metadata cleanup failed", {
      cause: error,
    });
  throw error;
}

export async function startQualifiedDaemon(): Promise<void> {
  const owner = await getQualifiedDaemonOwner();
  ManagedPluginPolicySchema.parse((await readFixedManagedPluginPolicy()).document);
  const home = resolvePaseoHome();
  const config = loadConfig(home);
  const logger = createRootLogger({ log: config.log }, { paseoHome: home });
  const dependencies: PaseoDaemonDependencies = { qualifiedDaemonOwner: owner };
  await owner.refresh();
  owner.assertFresh();
  const readiness = await acquireQualifiedDaemonReadiness(home);
  let measurement: ReturnType<typeof attachQualifiedDaemonMeasurement> | null = null;
  try {
    const activeMeasurement = attachQualifiedDaemonMeasurement(owner);
    measurement = activeMeasurement;
    const daemon = await createPaseoDaemon(config, logger, dependencies);
    readiness.assertHealthy();
    await owner.refresh();
    owner.assertFresh();
    await daemon.start();
    readiness.assertHealthy();
    await owner.refresh();
    owner.assertFresh();
    const listen = formatListenTarget(daemon.getListenTarget());
    if (!listen) throw new Error("Daemon did not expose a listen target after startup");
    await readiness.publish(listen, daemon.getServerId());
    await owner.refresh();
    owner.assertFresh();
    readiness.assertHealthy();
    activeMeasurement.started(daemon);
    let stopping: Promise<void> | null = null;
    const stop = (): Promise<void> => {
      if (stopping) return stopping;
      stopping = (async () => {
        const errors: unknown[] = [];
        try {
          activeMeasurement.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await readiness.clearAndDrain();
        } catch (error) {
          errors.push(error);
        }
        try {
          await daemon.stop({ keepTerminals: false });
        } catch (error) {
          errors.push(error);
        }
        if (!errors.length) {
          try {
            await readiness.releaseAfterStop();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, "Daemon shutdown and metadata cleanup failed", {
            cause: errors[0],
          });
      })();
      return stopping;
    };
    const requestStop = () => {
      void stop().catch((error) => {
        logger.error({ err: error }, "Qualified daemon shutdown remains unproved");
        process.exitCode = 1;
      });
    };
    // Early-start signal/factory unwind remains a separate, unsupported boundary.
    process.once("SIGTERM", requestStop);
    process.once("SIGINT", requestStop);
    void readiness.failed.then(() => {
      requestStop();
      return undefined;
    });
  } catch (error) {
    const cleanup: unknown[] = [];
    try {
      measurement?.close();
    } catch (failure) {
      cleanup.push(failure);
    }
    try {
      await readiness.clearAndDrain();
    } catch (failure) {
      cleanup.push(failure);
    }
    // Partial construction/start is not known stopped: retain the non-ready record.
    throwStartupFailure(error, cleanup);
  }
}
