/** Códigos de error de docs/API_CONTRACT.md (+ RATE_LIMITED / INTERNAL_ERROR, ver README). */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'INVALID_SIGNATURE'
  | 'SIGNATURE_REQUIRED'
  | 'REPLAYED_NONCE'
  | 'OTP_INVALID'
  | 'KYC_REQUIRED'
  | 'KYC_PENDING'
  | 'BREB_KEY_EXISTS'
  | 'BREB_ALIAS_NOT_FOUND'
  | 'BREB_ALIAS_TAKEN'
  | 'AML_REJECTED'
  | 'AML_REVIEW'
  | 'BENEFICIARY_NOT_ACTIVE'
  | 'LIMIT_EXCEEDED'
  | 'INSUFFICIENT_FUNDS'
  | 'QUOTE_EXPIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PROVIDER_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  // Portal admin / cuenta congelada (docs/ADMIN_API.md)
  | 'FORBIDDEN'
  | 'ACCOUNT_FROZEN'
  | 'CONFLICT';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  INVALID_SIGNATURE: 401,
  SIGNATURE_REQUIRED: 401,
  REPLAYED_NONCE: 401,
  OTP_INVALID: 401,
  KYC_REQUIRED: 403,
  KYC_PENDING: 403,
  BREB_KEY_EXISTS: 409,
  BREB_ALIAS_NOT_FOUND: 404,
  BREB_ALIAS_TAKEN: 409,
  AML_REJECTED: 422,
  AML_REVIEW: 422,
  BENEFICIARY_NOT_ACTIVE: 422,
  LIMIT_EXCEEDED: 422,
  INSUFFICIENT_FUNDS: 422,
  QUOTE_EXPIRED: 422,
  IDEMPOTENCY_CONFLICT: 409,
  PROVIDER_ERROR: 502,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  FORBIDDEN: 403,
  ACCOUNT_FROZEN: 403,
  CONFLICT: 409,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, status?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? STATUS[code];
    this.details = details;
  }

  toBody() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
