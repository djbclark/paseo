import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneBoundedObservation,
  parseQualifiedMeasurementRequest,
} from "../dist/server/server/execution/measurement-format.js";
test("fixed measurement request admits only type/version/bounded nonce", () => {
  const request = {
    type: "qualified.measurement.request",
    schemaVersion: 1,
    nonce: "valid-measurement-nonce",
  };
  assert.deepEqual(parseQualifiedMeasurementRequest(request), request);
  for (const added of [
    { command: "compile" },
    { path: "/candidate" },
    { ownerToken: "fake" },
    { operation: "replace" },
    { expectedIncarnation: "fake" },
  ])
    assert.equal(parseQualifiedMeasurementRequest({ ...request, ...added }), null);
  assert.equal(parseQualifiedMeasurementRequest({ ...request, nonce: "short" }), null);
  assert.equal(parseQualifiedMeasurementRequest({ ...request, nonce: "x".repeat(129) }), null);
});
test("pre-send bounded data retains Unicode and escaped byte content", () => {
  const observation = { nonce: "unicode", value: 'é雪😀\n"\\', rows: [null, true, 42] };
  assert.deepEqual(cloneBoundedObservation(observation), observation);
});
test("pre-send payload/count boundary refuses overflow and authority serialization", () => {
  for (const value of [
    { rows: Array(257).fill(null) },
    { value: "x".repeat(16777217) },
    { capability: { evidenceDigest: "fake" } },
    { ownerToken: "secret" },
    { scopeToken: "secret" },
    { call: () => {} },
    { value: 1n },
    { value: NaN },
  ])
    assert.throws(() => cloneBoundedObservation(value));
  let deep = null;
  for (let i = 0; i < 18; i++) deep = { nested: deep };
  assert.throws(() => cloneBoundedObservation(deep));
  assert.throws(() => cloneBoundedObservation({ value: "\0".repeat(3000000) }), /payload bound/);
});

// Canonical source/profile data is build/controller evidence, never a capability.
test("builtin canonical identity orders UTF-8 keys and rejects non-data or invalid Unicode", async () => {
  const { canonicalBuiltinJson } =
    await import("../dist/server/server/execution/builtin-format.js");
  assert.equal(
    canonicalBuiltinJson({ "😀": 2, "\ue000": 1, é: "雪" }),
    '{"é":"雪","\ue000":1,"😀":2}',
  );
  assert.equal(
    canonicalBuiltinJson({ b: [3, 2, 1], a: { z: false, n: null } }),
    '{"a":{"n":null,"z":false},"b":[3,2,1]}',
  );
  for (const value of [undefined, NaN, Infinity, () => {}, new Date(), "\ud800", { "\ud800": 1 }])
    assert.throws(() => canonicalBuiltinJson(value));
});
test("builtin profile rows require exact finite artifact identity without granting a brand", async () => {
  const { readBuiltinProfiles } =
    await import("../dist/server/server/execution/builtin-profile.js");
  const row = {
    id: "worktree-include",
    sourceSha256: "a".repeat(64),
    serverBundleSha256: "b".repeat(64),
    moduleTableSha256: "c".repeat(64),
    profileSha256: "d".repeat(64),
    activityContract: "builtin-in-process-v1",
  };
  assert.deepEqual(readBuiltinProfiles([row]), [row]);
  for (const value of [
    undefined,
    {},
    [row, row],
    [{ ...row, id: "candidate" }],
    [{ ...row, profileSha256: "D".repeat(64) }],
    [{ ...row, permission: true }],
    [{ ...row, activityContract: "plugin-child" }],
  ])
    assert.equal(readBuiltinProfiles(value), null);
});

test("descriptive builtin data and wrong role cannot mint an original instance", async () => {
  const producer = await import("../dist/server/server/execution/builtin-instance.js");
  const fakeOwner = {
    root: "/retained",
    binding: { expectedIncarnation: "fake" },
    assertFresh() {},
    refresh: async () => {},
  };
  assert.throws(() => producer.assertQualifiedBuiltinInstance({}, fakeOwner, "worktree-include"));
  await assert.rejects(() =>
    producer.createQualifiedBuiltinInstance(fakeOwner, "worktree-include"),
  );
});
