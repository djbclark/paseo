import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
import * as util from "node:util";
import * as timersPromises from "node:timers/promises";
import { createRequire } from "node:module";
import { qualifiedBindings } from "./qualified-bindings.js";
import recipe from "./builtin-bindings-recipe.json" with { type: "json" };
const nodeRequire = createRequire(import.meta.url);
const captured = {
  fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
};
// Captured from the retained executing Node. No arbitrary package/node fallback.
let sqlite: object | undefined;
try {
  sqlite = nodeRequire("node:sqlite");
} catch {
  /* Optional facility retains upstream unavailable behavior. */
}
const nodeBindings: Readonly<Record<string, object | undefined>> = Object.freeze({
  "node:fs": fs,
  "node:fs/promises": fsPromises,
  "node:os": os,
  "node:path": path,
  "node:crypto": crypto,
  "node:readline": readline,
  "node:util": util,
  "node:timers/promises": timersPromises,
  "node:sqlite": sqlite,
});
let table: Readonly<Record<string, object | undefined>> | null = null;
let sdkIdentities: ReadonlyMap<string, object> | null = null;
export function captureBuiltinBindings(): Readonly<Record<string, object | undefined>> {
  if (table) {
    assertBuiltinBindings();
    return table;
  }
  const helper = qualifiedBindings["@getpaseo/plugin/internal/builtin-helper"];
  const execFile = helper && Reflect.get(helper, "execQualifiedBuiltinFile");
  if (typeof execFile !== "function") throw new Error("Scoped builtin helper surface unavailable");
  const sdk = Object.fromEntries(
    recipe.sdkKeys.map((key) => {
      const value = qualifiedBindings[key];
      if (!value) throw new Error("Builtin SDK binding unavailable");
      return [key, value];
    }),
  );
  sdkIdentities = new Map(
    [...recipe.sdkKeys, ...recipe.privateBindings].map((key) => {
      const value = qualifiedBindings[key];
      if (!value) throw new Error("Builtin private binding unavailable");
      return [key, value];
    }),
  );
  table = Object.freeze({
    ...sdk,
    ...nodeBindings,
    "node:child_process": Object.freeze({ execFile }),
  });
  assertBuiltinBindings();
  return table;
}
export function assertBuiltinBindings(): void {
  if (!table || !sdkIdentities) throw new Error("Builtin binding table not captured");
  for (const [key, value] of sdkIdentities)
    if (qualifiedBindings[key] !== value) throw new Error("Builtin namespace substitution");
  for (const key of Object.keys(captured) as (keyof typeof captured)[])
    if (globalThis[key] !== captured[key]) throw new Error("Builtin global substitution");
  const helper = qualifiedBindings["@getpaseo/plugin/internal/builtin-helper"];
  if (
    JSON.stringify(Object.keys(table).sort()) !==
    JSON.stringify([...recipe.sdkKeys, ...recipe.nodeKeys].sort())
  )
    throw new Error("Builtin module inventory substitution");
  if (
    Reflect.get(table["node:child_process"]!, "execFile") !==
    Reflect.get(helper, "execQualifiedBuiltinFile")
  )
    throw new Error("Builtin helper facade substitution");
}
export function builtinRuntimeRequire(name: string): object {
  assertBuiltinBindings();
  if (!table || !Object.hasOwn(table, name) || !table[name])
    throw new Error("Unknown builtin runtime import");
  return table[name]!;
}
const builtinProcess = Object.create(process) as NodeJS.Process;
Object.defineProperty(builtinProcess, "getBuiltinModule", {
  value: (name: string) => {
    const key = name.startsWith("node:") ? name : `node:${name}`;
    if (key === "node:sqlite" && !sqlite) return undefined;
    return builtinRuntimeRequire(key);
  },
  writable: false,
  configurable: false,
});
export const builtinGlobals = Object.freeze({
  ...captured,
  process: builtinProcess,
  import: async (name: string) => builtinRuntimeRequire(name),
});

const namespaceIds = new WeakMap<object, string>();
function objectId(value: object): string {
  let id = namespaceIds.get(value);
  if (!id) {
    id = randomUUID();
    namespaceIds.set(value, id);
  }
  return id;
}
/** Actual consumed object/function identities, data only and stable for this incarnation. */
export function observeBuiltinBindings() {
  assertBuiltinBindings();
  const nodes = Object.entries(table!).map(([key, value]) => ({
    key,
    objectId: value ? objectId(value) : null,
  }));
  const privateRows = [...sdkIdentities!]
    .filter(([key]) => recipe.privateBindings.includes(key))
    .map(([key, value]) => ({ key, objectId: objectId(value) }));
  const globals = Object.entries(captured).map(([key, value]) => ({
    key,
    objectId: objectId(value),
  }));
  return {
    namespaces: [...nodes, ...privateRows].sort((a, b) =>
      Buffer.compare(Buffer.from(a.key, "utf8"), Buffer.from(b.key, "utf8")),
    ),
    globals,
    processObjectId: objectId(process),
    processFacadeId: objectId(builtinProcess),
  };
}
