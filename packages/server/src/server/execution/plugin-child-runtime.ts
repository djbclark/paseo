import * as worker from "../plugins/plugin-process.js";
import type { PluginWorker, PluginWorkerChannel } from "../plugins/plugin-process.js";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import {
  evaluateQualifiedBundle,
  getQualifiedHost,
  initializeQualifiedChildHost,
  refreshQualifiedChildHost,
} from "./qualified-host.js";
export async function attachQualifiedPluginHost(): Promise<void> {
  await initializeQualifiedChildHost();
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
  // Only this fixed entry captures the actual returned worker, before IPC can dispatch.
  // Context DATA is not authority; these references must be the originals we just attached.
  let original: PluginWorker | null = null;
  original = worker.attachPluginWorkerChannel(
    channel,
    (source, context): PluginServerContribution => {
      if (
        !original ||
        context.workerIdentity !== original ||
        context.activityOwner !== original.activityOwner ||
        context.initialize.bundle !== source ||
        !Object.isFrozen(original) ||
        !Object.isFrozen(context) ||
        !Object.isFrozen(context.initialize)
      )
        throw new Error("Qualified worker initialization identity mismatch");
      const result = evaluateQualifiedBundle(source);
      const contribution =
        result && typeof result === "object" ? Reflect.get(result, "default") : undefined;
      if (typeof contribution !== "function") throw new Error("Qualified contribution unavailable");
      return contribution as PluginServerContribution;
    },
  );
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
