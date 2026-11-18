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
