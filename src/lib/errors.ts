/**
 * Every failure the gateway returns goes through GatewayError so callers always
 * get a stable machine-readable `code` alongside the HTTP status.
 */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof GatewayError) {
    return Response.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status },
    );
  }
  console.error("[ledgerline] unhandled error", err);
  return Response.json(
    { error: { code: "internal_error", message: "Unexpected gateway error" } },
    { status: 500 },
  );
}
