import { readQualifiedBuiltinHelperContext } from "./builtin-instance.js";
import type { QualifiedDaemonOwner } from "./daemon-types.js";

export type BuiltinGitObservationPhase = "preflight" | "ready" | "settlement";
const observers = new WeakMap<
  object,
  (phase: BuiltinGitObservationPhase) => void | Promise<void>
>();
/** Internal read-only timing observation: receives no token, validator or facts.
 * It cannot create an owner/instance/root or approve any execution. Candidate
 * module tables never expose execution/*; the fixed CI composition entry uses
 * this to schedule real concurrent refresh and authority-revocation races. */
export function observeBuiltinGitPhases(
  instance: object,
  owner: QualifiedDaemonOwner,
  observer: (phase: BuiltinGitObservationPhase) => void | Promise<void>,
): () => void {
  readQualifiedBuiltinHelperContext(instance, owner);
  if (observers.has(instance)) throw new Error("Builtin phase observer already attached");
  observers.set(instance, observer);
  return () => {
    if (observers.get(instance) === observer) observers.delete(instance);
  };
}
export async function publishBuiltinGitPhase(
  instance: object,
  phase: BuiltinGitObservationPhase,
): Promise<void> {
  await observers.get(instance)?.(phase);
}
