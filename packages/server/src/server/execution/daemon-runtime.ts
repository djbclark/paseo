import { getQualifiedDaemonOwner } from "./daemon-owner.js";
import { createPaseoDaemon, type PaseoDaemonDependencies } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { createRootLogger } from "../logger.js";
import { resolvePaseoHome } from "../paseo-home.js";
export async function startQualifiedDaemon(): Promise<void> {
  const owner = await getQualifiedDaemonOwner();
  const home = resolvePaseoHome();
  const config = loadConfig(home);
  const logger = createRootLogger({ log: config.log }, { paseoHome: home });
  const dependencies: PaseoDaemonDependencies = { qualifiedDaemonOwner: owner };
  const daemon = await createPaseoDaemon(config, logger, dependencies);
  await owner.refresh();
  owner.assertFresh();
  await daemon.start();
  await owner.refresh();
  owner.assertFresh();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await daemon.stop({ keepTerminals: false });
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
}
