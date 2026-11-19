import { z } from "zod";

export const ADE_DIRECTORY_MAX_INPUT = 65536;
export const ADE_DIRECTORY_MAX_OUTPUT = 1048576;

/** Byte bounds mirror the selected retained Python dispatcher, not runtime authority. */
function text(limit: number, allowNul = false) {
  return z
    .string()
    .refine(
      (value) =>
        Buffer.byteLength(value, "utf8") <= limit &&
        Buffer.from(value, "utf8").toString("utf8") === value &&
        (allowNul || !value.includes("\0")),
      "Invalid bounded UTF-8 text",
    );
}
const id = text(128).refine((value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value));
const directory = text(4096).refine(
  (value) =>
    value.startsWith("/") &&
    (value === "/" || !value.endsWith("/")) &&
    !value.includes("//") &&
    !value.split("/").some((part) => part === "." || part === ".."),
  "Directory must have canonical absolute spelling",
);
const base = { version: z.literal(1), cwd: directory };
const operation = <T extends string>(name: T) => ({ ...base, operation: z.literal(name) });
const selection = z.enum(["head", "origin", "git-dir", "common-dir", "hooks-path"]);
export const AdeDirectoryRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...operation("repository-facts"), selection }).strict(),
  z.object(operation("claim-list")).strict(),
  z
    .object({
      ...operation("claim-new"),
      branch: text(1024),
      claimId: id,
      ttlHours: z.number().finite().min(0).max(8784),
      ownerAgent: z.union([id, z.literal("")]),
      ownerRecord: id.nullable(),
    })
    .strict(),
  z.object({ ...operation("claim-bind-owner"), claimId: id, agentId: id }).strict(),
  z.object({ ...operation("claim-release"), claimId: id }).strict(),
  z.object(operation("claim-install-hooks")).strict(),
  z
    .object({
      ...operation("window-name-decision"),
      windowTitle: text(8192).nullable(),
      firstAgent: z.boolean(),
      background: z.boolean(),
      agent: z
        .object({
          title: text(8192).nullable(),
          parentAgentId: id.nullable(),
          labels: z
            .record(text(128), text(1024))
            .refine((labels) => Object.keys(labels).length <= 64),
        })
        .strict(),
    })
    .strict(),
]);
export type AdeDirectoryRequest = z.infer<typeof AdeDirectoryRequestSchema>;
export type AdeDirectoryOperation = AdeDirectoryRequest["operation"];

const largeText = text(ADE_DIRECTORY_MAX_OUTPUT);
export const AdeClaimRecordSchema = z
  .object({
    v: z.literal(1),
    id,
    path: largeText,
    repo_origin: largeText,
    branch: largeText,
    base_sha: largeText,
    owner: z
      .object({
        record: largeText.nullable(),
        session: largeText.nullable(),
        agent: largeText,
        model: largeText,
      })
      .strict(),
    allow: z.array(largeText).max(4096),
    created_at: largeText,
    state: z.enum(["active", "released", "merged"]),
    shown_state: z.enum(["active", "released", "merged", "expired"]),
    expires_at: largeText.nullable(),
    lead: largeText.nullable().optional(),
    role: z.enum(["lead", "worker", "builder"]).optional(),
    purpose: largeText.optional(),
    created_by: largeText.optional(),
    released_at: largeText.nullable().optional(),
    inherited_dirt_patch: largeText.nullable().optional(),
  })
  .strict();
const envelope = <const Status extends number, T extends z.ZodType>(status: Status, output: T) =>
  z.object({ version: z.literal(1), status: z.literal(status), output }).strict();
const diagnostic = text(256);
const invalid = envelope(
  2,
  z.object({ kind: z.enum(["invalid-request", "claim-refused"]), diagnostic }).strict(),
);
const exists = envelope(3, z.object({ kind: z.literal("claim-exists"), diagnostic }).strict());
const claimed = envelope(4, z.object({ kind: z.literal("path-claimed"), diagnostic }).strict());
const claimId = z.object({ claimId: id }).strict();
const notes = z.object({ notes: z.array(text(8192)).max(16) }).strict();
const naming = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("rename"),
      name: largeText,
      kind: z.enum(["LEAD", "WORKER", "OTHER"]),
      repo: largeText,
      work: largeText,
    })
    .strict(),
  z.object({ action: z.literal("skip"), reason: largeText, retry: z.boolean() }).strict(),
]);
const factsResult = z
  .object({
    version: z.literal(1),
    selection,
    status: z.union([z.literal(0), z.literal(1)]),
    stdout: text(65536, true),
  })
  .strict()
  .refine(
    (result) =>
      (result.selection === "hooks-path" || !result.stdout.includes("\0")) &&
      (result.status === 0 || result.selection === "origin" || result.selection === "hooks-path"),
  );
const schemas = {
  "repository-facts": factsResult,
  "claim-list": z.union([
    envelope(0, z.array(AdeClaimRecordSchema).max(4096)),
    invalid,
    exists,
    claimed,
  ]),
  "claim-new": z.union([
    envelope(0, z.object({ claimId: id, registryPath: largeText }).strict()),
    invalid,
    exists,
    claimed,
  ]),
  "claim-bind-owner": z.union([envelope(0, claimId), invalid, exists, claimed]),
  "claim-release": z.union([envelope(0, claimId), invalid, exists, claimed]),
  "claim-install-hooks": z.union([
    envelope(0, notes),
    envelope(2, notes),
    envelope(73, notes),
    envelope(78, notes),
    invalid,
    exists,
    claimed,
  ]),
  "window-name-decision": z.union([envelope(0, naming), invalid, exists, claimed]),
};
export type AdeDirectoryResult<O extends AdeDirectoryOperation = AdeDirectoryOperation> = z.infer<
  (typeof schemas)[O]
>;

export function parseAdeDirectoryRequest(value: unknown): AdeDirectoryRequest {
  const request = AdeDirectoryRequestSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > ADE_DIRECTORY_MAX_INPUT)
    throw new Error("Directory operation request exceeds byte limit");
  return request;
}

/** JSON.parse validates syntax; this separate token pass rejects repeated escaped keys. */
function parseUniqueJson(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const stack: Array<{ keys: Set<string>; key: boolean } | null> = [];
  for (const token of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]/g)) {
    if (stack.length > 32) throw new Error("Directory result nesting limit exceeded");
    const tokenText = token[0];
    const top = stack.at(-1);
    if (tokenText === "{") stack.push({ keys: new Set(), key: true });
    else if (tokenText === "[") stack.push(null);
    else if (tokenText === "}" || tokenText === "]") stack.pop();
    else if (tokenText === "," && top) top.key = true;
    else if (tokenText.startsWith('"') && top?.key) {
      const key = z.string().parse(JSON.parse(tokenText));
      if (top.keys.has(key)) throw new Error("Duplicate directory result key");
      top.keys.add(key);
      top.key = false;
    }
  }
  return value;
}
export function parseAdeDirectoryResult<O extends AdeDirectoryOperation>(
  request: Extract<AdeDirectoryRequest, { operation: O }>,
  raw: Uint8Array,
  exitCode: number,
): AdeDirectoryResult<O>;
export function parseAdeDirectoryResult(
  request: AdeDirectoryRequest,
  raw: Uint8Array,
  exitCode: number,
): AdeDirectoryResult {
  if (raw.byteLength > ADE_DIRECTORY_MAX_OUTPUT)
    throw new Error("Directory result exceeds byte limit");
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  const result = schemas[request.operation].parse(parseUniqueJson(decoded));
  if (result.status !== exitCode) throw new Error("Directory result exit/status mismatch");
  if (
    request.operation === "repository-facts" &&
    "selection" in result &&
    result.selection !== request.selection
  )
    throw new Error("Directory fact selection mismatch");
  if (
    "claimId" in request &&
    "output" in result &&
    typeof result.output === "object" &&
    result.output !== null &&
    "claimId" in result.output &&
    result.output.claimId !== request.claimId
  )
    throw new Error("Directory result claim identity mismatch");
  return result;
}

const emptyFacts = z.object({}).strict();
const factSchemas = {
  "claim-list": emptyFacts,
  "claim-bind-owner": emptyFacts,
  "claim-release": emptyFacts,
  "claim-new": z
    .object({ head: z.string().regex(/^[0-9a-f]{40}$/), origin: text(65536), gitDir: directory })
    .strict(),
  "claim-install-hooks": z
    .object({
      commonDir: directory,
      hooksStatus: z.union([z.literal(0), z.literal(1)]),
      hooksOutput: text(65536, true),
    })
    .strict(),
  "window-name-decision": z.object({ commonDir: directory }).strict(),
};
/** Producer prepares DATA; both semantic identity and exact Python fact shape must match. */
export function validateAdeDirectoryInput(request: AdeDirectoryRequest, input: Uint8Array): void {
  if (request.operation === "repository-facts")
    throw new Error("Repository facts cannot launch Python");
  if (input.byteLength > ADE_DIRECTORY_MAX_INPUT)
    throw new Error("Directory input exceeds byte limit");
  const value = z
    .object({ version: z.literal(1), request: AdeDirectoryRequestSchema, facts: z.unknown() })
    .strict()
    .parse(
      parseUniqueJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input)),
    );
  if (JSON.stringify(value.request) !== JSON.stringify(request))
    throw new Error("Directory input request identity mismatch");
  factSchemas[request.operation].parse(value.facts);
}
