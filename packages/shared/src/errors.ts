/** Stable, machine-readable error codes shared by API, SDK, MCP server and web. */
export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  RFQ_NOT_FOUND: "RFQ_NOT_FOUND",
  RFQ_EXPIRED: "RFQ_EXPIRED",
  RFQ_CLOSED: "RFQ_CLOSED",
  RFQ_FULLY_FILLED: "RFQ_FULLY_FILLED",
  QUOTE_NOT_FOUND: "QUOTE_NOT_FOUND",
  QUOTE_TOO_LARGE: "QUOTE_TOO_LARGE",
  QUOTE_ALREADY_ACCEPTED: "QUOTE_ALREADY_ACCEPTED",
  TERMS_MISMATCH: "TERMS_MISMATCH",
  SIG_INVALID: "SIG_INVALID",
  DEAL_NOT_FOUND: "DEAL_NOT_FOUND",
  TX_NOT_FOUND: "TX_NOT_FOUND",
  TX_NOT_SETTLEMENT: "TX_NOT_SETTLEMENT",
  TOKEN_NOT_CONTRACT: "TOKEN_NOT_CONTRACT",
  UNSUPPORTED_PAY_TOKEN: "UNSUPPORTED_PAY_TOKEN",
  RELAY_FEE_TOO_LOW: "RELAY_FEE_TOO_LOW",
  RELAY_SIMULATION_FAILED: "RELAY_SIMULATION_FAILED",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const httpStatusOf: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  IDEMPOTENCY_CONFLICT: 409,
  RFQ_NOT_FOUND: 404,
  RFQ_EXPIRED: 410,
  RFQ_CLOSED: 409,
  RFQ_FULLY_FILLED: 409,
  QUOTE_NOT_FOUND: 404,
  QUOTE_TOO_LARGE: 413,
  QUOTE_ALREADY_ACCEPTED: 409,
  TERMS_MISMATCH: 422,
  SIG_INVALID: 422,
  DEAL_NOT_FOUND: 404,
  TX_NOT_FOUND: 404,
  TX_NOT_SETTLEMENT: 422,
  TOKEN_NOT_CONTRACT: 422,
  UNSUPPORTED_PAY_TOKEN: 422,
  RELAY_FEE_TOO_LOW: 422,
  RELAY_SIMULATION_FAILED: 422,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId?: string; problems?: { path: string; message: string }[] };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly problems: { path: string; message: string }[] | undefined;

  constructor(code: ErrorCode, message: string, problems?: { path: string; message: string }[]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = httpStatusOf[code];
    this.problems = problems;
  }

  toBody(requestId?: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { requestId } : {}),
        ...(this.problems ? { problems: this.problems } : {}),
      },
    };
  }
}
