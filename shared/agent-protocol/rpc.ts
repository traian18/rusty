// ============================================================
// rpc.ts — The reverse-RPC error class, moved here from
// agent-sidecar/src/services/websocket.ts (which re-exports it
// unchanged so its existing importers are unaffected) so both
// runtimes can share the same RpcError shape rather than the
// sidecar owning the only definition.
//
// RpcErrorCode itself lives in errors.ts, alongside the other two
// error-code vocabularies this package is unifying.
// ============================================================

import type { RpcErrorCode } from "./errors";

export class RpcError extends Error {
  constructor(
    public readonly code: RpcErrorCode,
    message: string,
    public readonly requestId: string,
    options?: { cause?: unknown },
  ) {
    // Built without passing `options` to `super()`: the two-argument
    // Error constructor (ErrorOptions.cause) needs an ES2022+ lib, which
    // the frontend's tsconfig doesn't set (this file now compiles under
    // both the sidecar's ES2022 config and the frontend's ES2020 one).
    super(message);
    this.name = "RpcError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}
