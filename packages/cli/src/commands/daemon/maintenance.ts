import { readFileSync, fstatSync } from "node:fs";
import { Command } from "commander";
import { verifyOfflineMaintenance } from "@getpaseo/server/maintenance-offline";
import { connectToDaemon } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions, addJsonOption } from "../../utils/command-options.js";
import { withOutput, type CommandOptions, type OutputSchema } from "../../output/index.js";

type Status =
  | ReturnType<typeof verifyOfflineMaintenance>
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
export function daemonMaintenanceCommand(): Command {
  const command = new Command("maintenance").description(
    "Reserve daemon admission for maintenance",
  );
  for (const operation of ["begin", "status", "end"] as const) {
    const sub = addJsonAndDaemonHostOptions(command.command(operation));
    if (operation !== "status")
      sub.requiredOption("--generation <number>", "Controller generation");
    if (operation === "begin")
      sub.requiredOption("--transaction-id <id>", "Controller transaction");
    if (operation === "end")
      sub.requiredOption("--owner-token-fd <fd>", "Private input FD (0 for stdin)");
    sub.action(
      withOutput(async (options: CommandOptions, _command: Command) => {
        if (operation === "begin" && !options.json)
          throw new Error("Begin requires --json to receive the owner token once");
        let token = "";
        if (operation === "end") {
          const fd = Number(options.ownerTokenFd);
          if (!Number.isSafeInteger(fd) || fd < 0 || fstatSync(fd).isCharacterDevice())
            throw new Error("Private token input required");
          token = readFileSync(fd, "utf8").trim();
          if (!/^[A-Za-z0-9_-]{43}$/.test(token))
            throw new Error("Invalid maintenance token input");
        }
        const client = await connectToDaemon({ target: options.daemonTarget });
        try {
          const payload =
            operation === "begin"
              ? await client.maintenanceBegin({
                  generation: generation(String(options.generation ?? "")),
                  transactionId: String(options.transactionId ?? ""),
                })
              : operation === "end"
                ? await client.maintenanceEnd({
                    generation: generation(String(options.generation ?? "")),
                    ownerToken: token,
                  })
                : await client.maintenanceStatus();
          if (payload.error || !payload.result) throw new Error("Maintenance request refused");
          return { type: "single" as const, data: payload.result, schema };
        } finally {
          await client.close();
        }
      }),
    );
  }
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
          data: verifyOfflineMaintenance(
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
