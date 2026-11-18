/** Canonical UTF-8 JSON v1: sorted object keys, ordered arrays, finite data only. */
export function canonicalBuiltinJson(value: unknown): string {
  if (typeof value === "string") {
    if (Buffer.from(value, "utf8").toString("utf8") !== value)
      throw new Error("Invalid builtin Unicode");
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalBuiltinJson).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("Invalid builtin canonical data");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
  );
  return `{${keys.map((key) => `${canonicalBuiltinJson(key)}:${canonicalBuiltinJson(record[key])}`).join(",")}}`;
}
