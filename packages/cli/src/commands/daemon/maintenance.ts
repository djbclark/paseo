import { readSync, fstatSync } from "node:fs";
import { Command } from "commander";
import { verifyOfflineMaintenance } from "@getpaseo/server/maintenance-offline";
import { connectToDaemon } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions, addJsonOption } from "../../utils/command-options.js";
import { withOutput, type CommandOptions, type OutputSchema } from "../../output/index.js";

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
function generation(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Invalid generation");
  return parsed;
}
export function readMaintenanceOwnerToken(fd: number): string {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("Private token input required");
  const stat = fstatSync(fd);
  if (stat.isCharacterDevice() || (stat.isFile() && (stat.mode & 0o077))) throw new Error("Private token input required");
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
    expectedServerId: options.expectedServerId === undefined ? undefined : String(options.expectedServerId),
    expectedDaemonIncarnation: options.expectedDaemonIncarnation === undefined ? undefined : String(options.expectedDaemonIncarnation),
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
        if (operation === "begin" && !options.json)
          throw new Error("Begin requires --json to receive the owner token once");
        const token = operation === "end" ? readMaintenanceOwnerToken(Number(options.ownerTokenFd)) : "";
        const client = await connectToDaemon({ target: options.daemonTarget });
        try {
          let payload;
          if (operation === "begin") payload = await client.maintenanceBegin({ generation: generation(String(options.generation ?? "")), transactionId: String(options.transactionId ?? ""), ...identity(options) });
          else if (operation === "end") payload = await client.maintenanceEnd({ generation: generation(String(options.generation ?? "")), ownerToken: token, transactionId: options.transactionId === undefined ? undefined : String(options.transactionId), ...identity(options) });
          else payload = await client.maintenanceStatus();
          if (payload.error || !payload.result) throw new Error("Maintenance request refused");
          return { type: "single" as const, data: payload.result, schema };
        } finally {
          await client.close();
        }
      }),
    );
  }
  addJsonAndDaemonHostOptions(command.command("plugin-operation")
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
    .requiredOption("--owner-token-fd <fd>", "Private input FD (0 for stdin)"))
    .action(withOutput(async (options: CommandOptions, _command: Command) => {
      const ownerToken = readMaintenanceOwnerToken(Number(options.ownerTokenFd));
      const operation = String(options.operation);
      if (operation !== "replace" && operation !== "recover" && operation !== "verify") throw new Error("Invalid maintenance operation");
      const expectedGeneration = Number(options.expectedGeneration);
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("Invalid native generation");
      const client = await connectToDaemon({ target: options.daemonTarget });
      try {
        const payload = await client.maintenancePluginOperation({ generation: generation(String(options.generation)), transactionId: String(options.transactionId), ownerToken, expectedServerId: String(options.expectedServerId), expectedDaemonIncarnation: String(options.expectedDaemonIncarnation), operation, pluginId: String(options.pluginId), path: String(options.path), expectedPath: String(options.expectedPath), expectedGeneration, snapshotSha256: String(options.snapshotSha256), serverBundleSha256: String(options.serverBundleSha256) });
        if (payload.error || !payload.result) throw new Error("Maintenance operation refused");
        const output: OutputSchema<NonNullable<typeof payload.result>> = { idField: () => "maintenance-operation", columns: [], renderHuman: () => "Maintenance operation completed" };
        return { type: "single" as const, data: payload.result, schema: output };
      } finally { await client.close(); }
    }));
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
