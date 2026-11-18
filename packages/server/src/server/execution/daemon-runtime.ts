import { attachQualifiedDaemonMeasurement } from "./daemon-measurement.js";
import { readFixedManagedPluginPolicy } from "./managed-policy-environment.js";
import { ManagedPluginPolicySchema } from "../plugins/activation-policy.js";
import { getQualifiedDaemonOwner } from "./daemon-owner.js";
import { createPaseoDaemon, type PaseoDaemonDependencies } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { createRootLogger } from "../logger.js";
import { resolvePaseoHome } from "../paseo-home.js";
export async function startQualifiedDaemon(): Promise<void> {
  const owner = await getQualifiedDaemonOwner();
  ManagedPluginPolicySchema.parse((await readFixedManagedPluginPolicy()).document);
  const home = resolvePaseoHome();
  const config = loadConfig(home);
  const logger = createRootLogger({ log: config.log }, { paseoHome: home });
  const dependencies: PaseoDaemonDependencies = { qualifiedDaemonOwner: owner };
  await owner.refresh();
  owner.assertFresh();
  const measurement = attachQualifiedDaemonMeasurement(owner);
  const daemon = await createPaseoDaemon(config, logger, dependencies);
  await owner.refresh();
  owner.assertFresh();
  await daemon.start();
  await owner.refresh();
  owner.assertFresh();
  measurement.started(daemon);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    measurement.close();
    await daemon.stop({ keepTerminals: false });
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
}
