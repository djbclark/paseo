// Build-only independent ELF observations. This never authorizes loading an ELF.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function range(bytes, offset, size) {
  assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(size));
  assert.ok(offset >= 0 && size >= 0 && offset + size <= bytes.length);
  return bytes.subarray(offset, offset + size);
}
function u64(bytes, offset) {
  const value = Number(range(bytes, offset, 8).readBigUInt64LE());
  assert.ok(Number.isSafeInteger(value));
  return value;
}
function string(bytes, offset) {
  assert.ok(offset >= 0 && offset < bytes.length);
  const end = bytes.indexOf(0, offset);
  assert.ok(end >= offset);
  const value = bytes.subarray(offset, end);
  const text = value.toString("utf8");
  assert.ok(Buffer.from(text).equals(value));
  return text;
}
function versionStrings(bytes, sections, strings) {
  const result = [];
  for (const section of sections.filter((p) => [0x6ffffffe, 0x6ffffffd].includes(p.type))) {
    const data = range(bytes, section.offset, section.size);
    const needed = section.type === 0x6ffffffe;
    let offset = 0,
      entries = 0;
    for (;;) {
      assert.ok(++entries <= 256);
      const row = range(data, offset, needed ? 16 : 20);
      const count = row.readUInt16LE(needed ? 2 : 6);
      assert.ok(count > 0 && count <= 256);
      if (needed) result.push(string(strings, row.readUInt32LE(4)));
      let aux = offset + row.readUInt32LE(needed ? 8 : 12);
      for (let i = 0; i < count; i++) {
        const entry = range(data, aux, needed ? 16 : 8);
        result.push(string(strings, entry.readUInt32LE(needed ? 8 : 0)));
        const next = entry.readUInt32LE(needed ? 12 : 4);
        if (i + 1 < count) assert.ok(next > 0);
        aux += next;
      }
      const next = row.readUInt32LE(needed ? 12 : 16);
      if (!next) break;
      assert.ok(next >= row.length);
      offset += next;
    }
  }
  return result;
}
export function auditSherpaElf(bytes) {
  assert.equal(range(bytes, 0, 7).toString("hex"), "7f454c46020101");
  assert.equal(bytes.readUInt16LE(16), 3); // The exact recipe is a shared x64 addon.
  assert.equal(bytes.readUInt16LE(18), 62);
  assert.equal(bytes.readUInt16LE(54), 56);
  assert.equal(bytes.readUInt16LE(58), 64);
  const programs = [];
  const programOffset = u64(bytes, 32),
    programCount = bytes.readUInt16LE(56);
  assert.ok(programCount > 0 && programCount <= 128);
  for (let i = 0; i < programCount; i++) {
    const row = range(bytes, programOffset + i * 56, 56);
    const entry = {
      type: row.readUInt32LE(0),
      flags: row.readUInt32LE(4),
      offset: u64(row, 8),
      address: u64(row, 16),
      fileSize: u64(row, 32),
      memorySize: u64(row, 40),
      alignment: u64(row, 48),
    };
    range(bytes, entry.offset, entry.fileSize);
    assert.ok(entry.fileSize <= entry.memorySize);
    assert.notEqual(entry.type, 3); // No interpreter may be introduced.
    if (entry.type === 1) assert.notEqual(entry.flags & 3, 3); // No writable executable load.
    programs.push(entry);
  }
  const sectionOffset = u64(bytes, 40),
    sectionCount = bytes.readUInt16LE(60);
  assert.ok(sectionCount > 0 && sectionCount <= 512);
  const rawSections = Array.from({ length: sectionCount }, (_, i) => {
    const row = range(bytes, sectionOffset + i * 64, 64);
    return {
      nameOffset: row.readUInt32LE(),
      type: row.readUInt32LE(4),
      flags: u64(row, 8),
      address: u64(row, 16),
      offset: u64(row, 24),
      size: u64(row, 32),
      alignment: u64(row, 48),
      entrySize: u64(row, 56),
    };
  });
  const names = rawSections[bytes.readUInt16LE(62)];
  assert.ok(names);
  const strings = range(bytes, names.offset, names.size);
  const sections = rawSections.map((row) => {
    const name = string(strings, row.nameOffset);
    const data = row.type === 8 ? null : range(bytes, row.offset, row.size);
    if (row.flags & 2)
      assert.ok(
        programs.some(
          (p) =>
            p.type === 1 &&
            row.address >= p.address &&
            row.address + row.size <= p.address + p.memorySize,
        ),
      );
    const loadFlags = programs
      .filter(
        (p) =>
          p.type === 1 &&
          row.address >= p.address &&
          row.address + row.size <= p.address + p.memorySize,
      )
      .map((p) => p.flags);
    const relro = programs.some(
      (p) =>
        p.type === 0x6474e552 &&
        row.address >= p.address &&
        row.address + row.size <= p.address + p.memorySize,
    );
    return { ...row, name, loadFlags, relro, sha256: data === null ? null : sha(data) };
  });
  const dynamic = programs.filter((p) => p.type === 2);
  assert.equal(dynamic.length, 1);
  const tags = [];
  for (
    let offset = dynamic[0].offset;
    offset < dynamic[0].offset + dynamic[0].fileSize;
    offset += 16
  ) {
    const tag = u64(bytes, offset),
      value = u64(bytes, offset + 8);
    if (!tag) break;
    tags.push({ tag, value });
  }
  const strtab = tags.filter((p) => p.tag === 5),
    strsize = tags.filter((p) => p.tag === 10);
  assert.equal(strtab.length, 1);
  assert.equal(strsize.length, 1);
  const load = programs.find(
    (p) =>
      p.type === 1 &&
      strtab[0].value >= p.address &&
      strtab[0].value + strsize[0].value <= p.address + p.fileSize,
  );
  assert.ok(load);
  const dynamicStrings = range(
    bytes,
    load.offset + strtab[0].value - load.address,
    strsize[0].value,
  );
  const symbolSections = sections.filter((p) => p.type === 11);
  assert.equal(symbolSections.length, 1);
  const symbols = symbolSections[0];
  assert.equal(symbols.entrySize, 24);
  assert.equal(symbols.size % 24, 0);
  const dynamicNames = [];
  for (let offset = 0; offset < symbols.size; offset += 24)
    dynamicNames.push(
      string(dynamicStrings, range(bytes, symbols.offset + offset, 24).readUInt32LE()),
    );
  const versionNames = versionStrings(bytes, sections, dynamicStrings);
  const dynamicTags = tags.map(({ tag, value }) => ({
    tag,
    value: [1, 14, 15, 29].includes(tag) ? string(dynamicStrings, value) : value,
  }));
  const executableLoads = programs
    .filter((p) => p.type === 1 && p.flags & 1)
    .map((p) => ({
      address: p.address,
      fileSize: p.fileSize,
      memorySize: p.memorySize,
      flags: p.flags,
      sha256: sha(range(bytes, p.offset, p.fileSize)),
    }));
  return {
    dynamicNames,
    versionNames,
    executableLoads,
    header: {
      identity: bytes.subarray(0, 24).toString("hex"),
      entry: u64(bytes, 24),
      flags: bytes.readUInt32LE(48),
    },
    programs,
    sections,
    dynamicTags,
  };
}
export function assertSherpaAdaptationSemantics(before, after) {
  assert.deepEqual(after.header, before.header);
  assert.deepEqual(after.dynamicNames, before.dynamicNames);
  assert.deepEqual(after.versionNames, before.versionNames);
  assert.deepEqual(after.executableLoads, before.executableLoads);
  // Layout offsets and string-table addresses may change. All other dynamic
  // semantics, including ordered NEEDED, flags, relocations and init pointers stay.
  const stableTags = (meta) => meta.dynamicTags.filter((p) => ![5, 10, 29].includes(p.tag));
  assert.deepEqual(stableTags(after), stableTags(before));
  assert.deepEqual(
    after.dynamicTags.filter((p) => p.tag === 29),
    [{ tag: 29, value: "$ORIGIN" }],
  );
  assert.deepEqual(
    after.dynamicTags.filter((p) => p.tag === 15),
    [],
  );
  const allocated = (meta) =>
    meta.sections
      .filter((p) => p.flags & 2)
      .filter((p) => ![".dynstr", ".dynamic"].includes(p.name))
      .map(
        ({ name, type, flags, address, size, alignment, entrySize, sha256, loadFlags, relro }) => ({
          name,
          loadFlags,
          relro,
          type,
          flags,
          address,
          size,
          alignment,
          entrySize,
          sha256,
        }),
      )
      .sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
  assert.deepEqual(allocated(after), allocated(before));
  const metadataProtection = (meta) =>
    meta.sections
      .filter((p) => [".dynstr", ".dynamic"].includes(p.name))
      .map(({ name, flags, loadFlags, relro }) => ({ name, flags, loadFlags, relro }));
  assert.deepEqual(metadataProtection(after), metadataProtection(before));
  const protections = (meta) =>
    meta.programs
      .filter((p) => [7, 0x6474e551, 0x6474e552, 0x6474e553].includes(p.type))
      .map(({ type, flags, address, memorySize }) => ({ type, flags, address, memorySize }));
  assert.deepEqual(protections(after), protections(before));
}
