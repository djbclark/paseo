import { isDeepStrictEqual } from "node:util";
import { readSync, fstatSync } from "node:fs";
import { Command } from "commander";
import { verifyOfflineMaintenance } from "@getpaseo/server/maintenance-offline";
import { connectToDaemon } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions, addJsonOption } from "../../utils/command-options.js";
import {
  withOutput,
  type CommandOptions,
  type OutputSchema,
  type CommandError,
  type SingleResult,
} from "../../output/index.js";

type Status =
  | Awaited<ReturnType<typeof verifyOfflineMaintenance>>
  | {
      schemaVersion: 1;
      state: "idle" | "held" | "recovery-required";
      generation: number | null;
      transactionId: string | null;
      recoveryRequired: boolean;
      ownerToken?: string;
    };
const schema: OutputSchema<Status> = {
  idField: () => "maintenance",
  columns: [],
  // A token is returned only in the explicit JSON result of successful begin.
  renderHuman: (result) => (result.type === "single" ? `Maintenance ${result.data.state}` : ""),
};
const knownBusyErrors = new WeakSet<object>();
export function maintenanceBeginRefusal(payload: {
  result: unknown;
  error: unknown;
  errorCode?: unknown;
}): CommandError {
  const knownBusy =
    payload.result === null &&
    typeof payload.error === "string" &&
    payload.error.length > 0 &&
    payload.errorCode === "MAINTENANCE_KNOWN_BUSY";
  const error = {
    code: knownBusy ? "MAINTENANCE_KNOWN_BUSY" : "UNKNOWN_ERROR",
    message: "Maintenance reservation refused",
  };
  if (knownBusy) knownBusyErrors.add(error);
  return error;
}
function generation(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Invalid generation");
  return parsed;
}
export function readMaintenanceOwnerToken(fd: number): string {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("Private token input required");
  const stat = fstatSync(fd);
  if (stat.isCharacterDevice() || (stat.isFile() && stat.mode & 0o077))
    throw new Error("Private token input required");
  const bytes = Buffer.alloc(129);
  let length = 0;
  while (length < bytes.length) {
    const read = readSync(fd, bytes, length, bytes.length - length, null);
    if (!read) break;
    length += read;
  }
  const token = bytes.subarray(0, length).toString("utf8");
  if (!/^[A-Za-z0-9_-]{43}\n?$/.test(token)) throw new Error("Invalid maintenance token input");
  return token.replace(/\n$/, "");
}
function identity(options: CommandOptions) {
  return {
    expectedServerId:
      options.expectedServerId === undefined ? undefined : String(options.expectedServerId),
    expectedDaemonIncarnation:
      options.expectedDaemonIncarnation === undefined
        ? undefined
        : String(options.expectedDaemonIncarnation),
  };
}

type MaintenanceOperationPayload = Awaited<
  ReturnType<Awaited<ReturnType<typeof connectToDaemon>>["maintenancePluginOperation"]>
>;
function knownFailureIdentityValid(
  known: NonNullable<MaintenanceOperationPayload["knownFailedHeld"]>,
): boolean {
  const authority = known.maintenance.authority;
  return (
    authority?.qualified === true &&
    authority.serverId === known.serverId &&
    authority.daemonIncarnation === known.daemonIncarnation &&
    known.maintenance.generation !== null &&
    known.maintenance.transactionId !== null &&
    known.maintenance.reservationGeneration === known.maintenance.generation &&
    known.maintenance.recoveryRequired === true
  );
}
function knownFailureAPIAvailable(
  known: NonNullable<MaintenanceOperationPayload["knownFailedHeld"]>,
): boolean {
  const features = known.maintenance.authority?.features;
  return (
    features?.maintenanceKnownFailedHeldV1 === true || features?.maintenanceHeldRecoveryV1 === true
  );
}
export function maintenancePluginOutput(payload: MaintenanceOperationPayload, supported: boolean) {
  if (payload.error) throw { code: "UNKNOWN_ERROR", message: "Maintenance operation refused" };
  if (payload.knownFailedHeld) {
    const known = payload.knownFailedHeld;
    if (
      payload.result ||
      !supported ||
      !knownFailureIdentityValid(known) ||
      !knownFailureAPIAvailable(known) ||
      !known.maintenance.recoveryOnly ||
      known.maintenance.state === "idle" ||
      known.maintenance.recoveryOnly.phase !== "recover-required" ||
      known.pluginId !== known.maintenance.recoveryOnly.pluginId ||
      known.nativeGeneration !== known.maintenance.recoveryOnly.nativeGeneration ||
      !isDeepStrictEqual(known.baseline, known.maintenance.recoveryOnly.baseline)
    )
      throw { code: "UNKNOWN_ERROR", message: "Maintenance operation refused" };
    return known;
  }
  if (!payload.result) throw { code: "UNKNOWN_ERROR", message: "Maintenance operation refused" };
  return payload.result;
}

function operationOutput<T>(data: T): SingleResult<T> {
  return {
    type: "single",
    data,
    schema: {
      idField: () => "maintenance-operation",
      columns: [],
      renderHuman: () => "Maintenance operation completed",
    },
  };
}

export function daemonMaintenanceCommand(): Command {
  const command = new Command("maintenance").description(
    "Reserve daemon admission for maintenance",
  );
  for (const operation of ["begin", "status", "end"] as const) {
    const sub = addJsonAndDaemonHostOptions(command.command(operation));
    if (operation !== "status") {
      sub.requiredOption("--generation <number>", "Controller generation");
      sub.option("--expected-server-id <id>", "Retained daemon identity");
      sub.option("--expected-daemon-incarnation <id>", "Retained daemon process incarnation");
    }
    if (operation === "begin")
      sub.requiredOption("--transaction-id <id>", "Controller transaction");
    if (operation === "end") {
      sub.requiredOption("--owner-token-fd <fd>", "Private input FD (0 for stdin)");
      sub.option("--transaction-id <id>", "Matching reservation transaction");
    }
    sub.action(
      withOutput(async (options: CommandOptions, _command: Command) => {
        try {
          if (operation === "begin" && !options.json)
            throw new Error("Begin requires --json to receive the owner token once");
          const token =
            operation === "end" ? readMaintenanceOwnerToken(Number(options.ownerTokenFd)) : "";
          const client = await connectToDaemon({ target: options.daemonTarget });
          try {
            let payload;
            if (operation === "begin")
              payload = await client.maintenanceBegin({
                generation: generation(String(options.generation ?? "")),
                transactionId: String(options.transactionId ?? ""),
                ...identity(options),
              });
            else if (operation === "end")
              payload = await client.maintenanceEnd({
                generation: generation(String(options.generation ?? "")),
                ownerToken: token,
                transactionId:
                  options.transactionId === undefined ? undefined : String(options.transactionId),
                ...identity(options),
              });
            else payload = await client.maintenanceStatus();
            if (payload.error || !payload.result) {
              if (operation === "begin") throw maintenanceBeginRefusal(payload);
              throw new Error("Maintenance request refused");
            }
            return { type: "single" as const, data: payload.result, schema };
          } finally {
            await client.close();
          }
        } catch (error) {
          if (operation !== "begin") throw error;
          if (typeof error === "object" && error !== null && knownBusyErrors.has(error))
            throw error;
          throw { code: "UNKNOWN_ERROR", message: "Maintenance reservation refused" };
        }
      }),
    );
  }
  addJsonAndDaemonHostOptions(
    command
      .command("plugin-operation")
      .requiredOption("--operation <operation>", "replace, recover or verify")
      .requiredOption("--generation <number>", "Reservation generation")
      .requiredOption("--transaction-id <id>", "Reservation transaction")
      .requiredOption("--expected-server-id <id>", "Retained daemon identity")
      .requiredOption("--expected-daemon-incarnation <id>", "Retained daemon incarnation")
      .requiredOption("--plugin-id <id>", "Exact managed plugin")
      .requiredOption("--path <path>", "Exact target source")
      .requiredOption("--expected-path <path>", "Exact current registered source")
      .requiredOption("--expected-generation <number>", "Native plugin journal CAS")
      .requiredOption("--snapshot-sha256 <sha256>", "Exact target snapshot digest")
      .requiredOption("--server-bundle-sha256 <sha256>", "Exact target bundle digest")
      .requiredOption("--owner-token-fd <fd>", "Private input FD (0 for stdin)"),
  ).action(
    withOutput<ReturnType<typeof maintenancePluginOutput>, []>(
      async (options: CommandOptions, _command: Command) => {
        const ownerToken = readMaintenanceOwnerToken(Number(options.ownerTokenFd));
        const operation = String(options.operation);
        if (operation !== "replace" && operation !== "recover" && operation !== "verify")
          throw new Error("Invalid maintenance operation");
        const expectedGeneration = Number(options.expectedGeneration);
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
          throw new Error("Invalid native generation");
        const client = await connectToDaemon({ target: options.daemonTarget });
        try {
          const payload = await client.maintenancePluginOperation({
            generation: generation(String(options.generation)),
            transactionId: String(options.transactionId),
            ownerToken,
            expectedServerId: String(options.expectedServerId),
            expectedDaemonIncarnation: String(options.expectedDaemonIncarnation),
            operation,
            pluginId: String(options.pluginId),
            path: String(options.path),
            expectedPath: String(options.expectedPath),
            expectedGeneration,
            snapshotSha256: String(options.snapshotSha256),
            serverBundleSha256: String(options.serverBundleSha256),
          });
          const result = maintenancePluginOutput(
            payload,
            options.json === true &&
              (client.getLastServerInfoMessage()?.features?.maintenanceKnownFailedHeldV1 === true ||
                client.getLastServerInfoMessage()?.features?.maintenanceHeldRecoveryV1 === true),
          );
          // AnyCommandResult distributes its union: retain each result's schema correlation.
          if ("outcome" in result) return operationOutput(result);
          return operationOutput(result);
        } finally {
          await client.close();
        }
      },
    ),
  );
  addJsonOption(
    command
      .command("verify-offline")
      .requiredOption("--generation <number>", "Expected controller generation")
      .requiredOption("--transaction-id <id>", "Expected controller transaction"),
  ).action(
    withOutput(async (options: CommandOptions, _command: Command) => {
      try {
        return {
          type: "single" as const,
          data: await verifyOfflineMaintenance(
            generation(String(options.generation ?? "")),
            String(options.transactionId ?? ""),
          ),
          schema,
        };
      } catch {
        throw new Error("Offline maintenance authority unavailable or mismatched");
      }
    }),
  );
  return command;
}
