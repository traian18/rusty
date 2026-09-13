// ============================================================
// validation.ts — Small hand-written field assertions, in the same
// style as envelope.ts's validateEnvelope (throw a plain Error with a
// field-naming message; no schema library -- see PR 4a's plan for why:
// shared/ is CommonJS, imported by both an ESM frontend and a CJS
// sidecar via relative paths, not as an npm dependency, so adding a
// schema library would mean pinning it in two package.jsons in
// lockstep, the exact coupling this package exists to reduce).
//
// These are deliberately generic rather than per-command validators:
// today's 9 capabilities' payload field names are still pre-rename
// (see commands.ts's header comment), so per-command validators
// written against today's names would just be thrown away as PR 4b
// renames each one. inlineChat.ts already validates its 5 required
// fields by hand today -- these helpers are what that inline style
// factors into, for PR 4b's other 8 capabilities to adopt as they
// migrate, not a replacement for inlineChat.ts's existing checks.
// ============================================================

import { isRecord } from "./envelope";

export class PayloadValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "PayloadValidationError";
  }
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PayloadValidationError(field, `${field} must be an object.`);
  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PayloadValidationError(field, `${field} must be a non-empty string.`);
  return value;
}

export function requireOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new PayloadValidationError(field, `${field} must be an array.`);
  return value;
}
