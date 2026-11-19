import { executeAdeDirectoryOperation } from "./process-internal/ade-directory.js";
import type { AdeDirectoryRequest, AdeDirectoryResult } from "./ade-directory-schema.js";
export type {
  AdeDirectoryRequest,
  AdeDirectoryResult,
  AdeDirectoryOperation,
} from "./ade-directory-schema.js";

/** Finite semantic DATA only; unavailable/unknown producer proof never falls back to raw execution. */
export function runAdeDirectoryOperation<R extends AdeDirectoryRequest>(
  request: R,
): Promise<AdeDirectoryResult<R["operation"]>>;
export function runAdeDirectoryOperation(
  request: AdeDirectoryRequest,
): Promise<AdeDirectoryResult> {
  return executeAdeDirectoryOperation(request);
}
