import * as worker from "../plugins/plugin-process.js";
import type { PluginWorkerChannel } from "../plugins/plugin-process.js";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import {
  evaluateQualifiedBundle,
  getQualifiedHost,
  initializeQualifiedChildHost,
  refreshQualifiedChildHost,
} from "./qualified-host.js";
export async function attachQualifiedPluginHost(): Promise<void> {
  await initializeQualifiedChildHost();
  const attach = Reflect.get(worker, "attachPluginWorkerChannel");
  if (typeof attach !== "function") throw new Error("Qualified worker initializer unavailable");
  const channel: PluginWorkerChannel = {
    send(message, callback) {
      process.send?.(message, () => callback?.());
    },
    onMessage(handler) {
      const receive = (raw: unknown) => {
        if (
          raw &&
          typeof raw === "object" &&
          Reflect.get(raw, "type") === "qualified.execution.challenge"
        )
          return;
        handler(raw as Parameters<typeof handler>[0]);
      };
      process.on("message", receive);
      return () => {
        process.off("message", receive);
      };
    },
    disconnect() {
      process.disconnect();
    },
  };
  attach(channel, (source: string): PluginServerContribution => {
    const result = evaluateQualifiedBundle(source);
    const contribution =
      result && typeof result === "object" ? Reflect.get(result, "default") : undefined;
    if (typeof contribution !== "function") throw new Error("Qualified contribution unavailable");
    return contribution as PluginServerContribution;
  });
}
export async function respondQualifiedChallenge(challenge: string): Promise<void> {
  await refreshQualifiedChildHost();
  const state = getQualifiedHost();
  process.send?.({
    challenge,
    pid: process.pid,
    incarnation: state.evidence.process.processStartToken,
    manifestSha256: state.evidence.qualificationManifestSha256,
    distributionBuildId: state.evidence.distributionBuildId,
    hostEvidence: state.evidence,
  });
}
