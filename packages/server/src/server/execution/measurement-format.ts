import { z } from "zod";
const MAX_JSON_BYTES = 16777216;
const Request = z
  .object({
    type: z.literal("qualified.measurement.request"),
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  })
  .strict();
export function parseQualifiedMeasurementRequest(raw: unknown): z.infer<typeof Request> | null {
  const result = Request.safeParse(raw);
  return result.success ? result.data : null;
}
/** Pre-send JSON payload/count bound, not an IPC frame/receiver heap guarantee. */
export function cloneBoundedObservation(value: unknown): unknown {
  let bytes = 0;
  function add(count: number): void {
    bytes += count;
    if (bytes > MAX_JSON_BYTES) throw new Error("Measurement exceeds fixed JSON payload bound");
  }
  function quoted(text: string): void {
    if (text.length > MAX_JSON_BYTES) throw new Error("Measurement string exceeds bound");
    add(Buffer.byteLength(JSON.stringify(text)));
  }
  function visit(current: unknown, depth: number): void {
    if (depth > 16) throw new Error("Measurement nesting exceeds bound");
    if (current === null) {
      add(4);
      return;
    }
    if (typeof current === "string") {
      quoted(current);
      return;
    }
    if (typeof current === "boolean") {
      add(current ? 4 : 5);
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Invalid observation number");
      add(String(current).length);
      return;
    }
    if (!current || typeof current !== "object") throw new Error("Non-data observation value");
    if (Array.isArray(current)) {
      if (current.length > 256) throw new Error("Measurement array exceeds count bound");
      add(2 + Math.max(0, current.length - 1));
      for (const row of current) visit(row, depth + 1);
      return;
    }
    if (
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    )
      throw new Error("Non-data observation prototype");
    const keys = Object.keys(current);
    if (keys.length > 64) throw new Error("Measurement object exceeds count bound");
    add(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      if (["capability", "ownerToken", "scopeToken"].includes(key))
        throw new Error("Authority is not an observation");
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value"))
        throw new Error("Observation accessor unavailable");
      quoted(key);
      add(1);
      visit(descriptor.value, depth + 1);
    }
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > MAX_JSON_BYTES)
    throw new Error("Measurement JSON payload changed");
  return JSON.parse(encoded) as unknown;
}
