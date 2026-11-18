export interface ElfDescription {
  machine: number;
  interpreter: string | null;
  needed: string[];
  rpath: string[];
  runpath: string[];
  soname: string | null;
}
function fail(): never {
  throw new Error("Unsupported finite ELF metadata");
}
function span(bytes: Buffer, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  )
    fail();
}
function number64(bytes: Buffer, offset: number): number {
  span(bytes, offset, 8);
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return Number(value);
}
function text(bytes: Buffer, offset: number, limit: number): string {
  span(bytes, offset, limit);
  const end = bytes.indexOf(0, offset);
  if (end < offset || end >= offset + limit || end - offset > 4096) return fail();
  const raw = bytes.subarray(offset, end);
  const value = raw.toString("utf8");
  if (!value || !Buffer.from(value, "utf8").equals(raw)) return fail();
  return value;
}
export function isTargetElf(bytes: Buffer, machine: number): boolean {
  return (
    bytes.length >= 64 &&
    bytes.readUInt32BE(0) === 0x7f454c46 &&
    bytes[4] === 2 &&
    bytes[5] === 1 &&
    bytes.readUInt16LE(18) === machine
  );
}
/** ELF64 little-endian PT_INTERP/PT_DYNAMIC derived from retained bytes, no tool assertions. */
export function describeElf(bytes: Buffer): ElfDescription {
  if (!isTargetElf(bytes, 62) && !isTargetElf(bytes, 183)) return fail();
  const offset = number64(bytes, 32);
  const count = bytes.readUInt16LE(56);
  const stride = bytes.readUInt16LE(54);
  if (!count || count > 4096 || stride !== 56) return fail();
  span(bytes, offset, count * stride);
  const segments = [];
  for (let i = 0; i < count; i++) {
    const start = offset + i * stride;
    const segment = {
      type: bytes.readUInt32LE(start),
      offset: number64(bytes, start + 8),
      address: number64(bytes, start + 16),
      size: number64(bytes, start + 32),
    };
    span(bytes, segment.offset, segment.size);
    segments.push(segment);
  }
  const interp = segments.filter((row) => row.type === 3);
  const dynamic = segments.filter((row) => row.type === 2);
  if (interp.length > 1 || dynamic.length > 1) return fail();
  const interpreter = interp[0] ? text(bytes, interp[0].offset, interp[0].size) : null;
  const result: ElfDescription = {
    machine: bytes.readUInt16LE(18),
    interpreter,
    needed: [],
    rpath: [],
    runpath: [],
    soname: null,
  };
  if (!dynamic[0]) return result;
  applyDynamic(bytes, dynamic[0], segments, result);
  return result;
}
interface ElfSegment {
  type: number;
  offset: number;
  address: number;
  size: number;
}
function applyDynamic(
  bytes: Buffer,
  dynamic: ElfSegment,
  segments: ElfSegment[],
  result: ElfDescription,
): void {
  const entries = [];
  let terminated = false;
  for (let current = dynamic.offset; current + 16 <= dynamic.offset + dynamic.size; current += 16) {
    const tag = bytes.readBigInt64LE(current);
    if (tag === 0n) {
      terminated = true;
      break;
    }
    if (entries.length > 65536) return fail();
    if ([0x6ffffefan, 0x6ffffefbn, 0x6ffffefcn, 0x7ffffffdn, 0x7fffffffn].includes(tag))
      return fail();
    entries.push({ tag, value: number64(bytes, current + 8) });
  }
  if (!terminated) return fail();
  const tables = entries.filter((row) => row.tag === 5n);
  const sizes = entries.filter((row) => row.tag === 10n);
  if (!entries.some((row) => [1n, 14n, 15n, 29n].includes(row.tag))) return;
  if (tables.length !== 1 || sizes.length !== 1 || sizes[0]!.value > 64 * 1024 * 1024)
    return fail();
  const table = tables[0]!.value;
  const length = sizes[0]!.value;
  const load = segments.find(
    (row) => row.type === 1 && table >= row.address && table + length <= row.address + row.size,
  );
  if (!load) return fail();
  const strings = load.offset + table - load.address;
  span(bytes, strings, length);
  for (const entry of entries) {
    if (![1n, 14n, 15n, 29n].includes(entry.tag)) continue;
    if (entry.value >= length) return fail();
    const value = text(bytes, strings + entry.value, length - entry.value);
    if (entry.tag === 1n) result.needed.push(value);
    if (entry.tag === 14n) {
      if (result.soname !== null) return fail();
      result.soname = value;
    }
    if (entry.tag === 15n) result.rpath.push(...value.split(":"));
    if (entry.tag === 29n) result.runpath.push(...value.split(":"));
  }
  if (
    result.needed.length > 128 ||
    result.rpath.some((row) => !row) ||
    result.runpath.some((row) => !row)
  )
    return fail();
}
export interface LoaderCacheEntry {
  soname: string;
  path: string;
  flags: number;
  hwcap: string;
}
/** Supported glibc new-cache1.1 only; old/unknown/endian variants HOLD. */
export function describeLoaderCache(bytes: Buffer, machine: number): LoaderCacheEntry[] {
  if (
    bytes.length < 48 ||
    bytes.length > 16 * 1024 * 1024 ||
    bytes.subarray(0, 20).toString("ascii") !== "glibc-ld.so.cache1.1"
  )
    return fail();
  if (![0, 2].includes(bytes[28]! & 3)) return fail();
  const count = bytes.readUInt32LE(20);
  const strings = bytes.readUInt32LE(24);
  if (count > 65536) return fail();
  span(bytes, 48, count * 24 + strings);
  let required: number;
  if (machine === 62) required = 0x0300;
  else if (machine === 183) required = 0x0a00;
  else return fail();
  const result = [];
  for (let i = 0; i < count; i++) {
    const start = 48 + i * 24;
    const flags = bytes.readInt32LE(start);
    if ((flags & 0xff00) !== required) continue;
    const key = bytes.readUInt32LE(start + 4),
      value = bytes.readUInt32LE(start + 8);
    if (key < 48 + count * 24 || value < 48 + count * 24) return fail();
    result.push({
      soname: text(bytes, key, 48 + count * 24 + strings - key),
      path: text(bytes, value, 48 + count * 24 + strings - value),
      flags,
      hwcap: bytes.readBigUInt64LE(start + 16).toString(),
    });
  }
  return result;
}
