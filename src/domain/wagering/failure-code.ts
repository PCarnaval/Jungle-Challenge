/**
 * Códigos de rejeição estáveis e legíveis por máquina (README item 7.2).
 *
 * Um provedor consumindo a API / os eventos deve conseguir decidir, só pelo
 * código, se reenvia como está, corrige o payload ou desiste — sem interpretar
 * uma mensagem humana.
 *
 *  REENVIAR (transitório — o retry pode dar certo):
 *    - REFERENCE_NOT_PROCESSED
 *
 *  CORRIGIR O PAYLOAD (determinístico — a requisição está errada):
 *    - VALIDATION_ERROR, WALLET_NOT_FOUND, WALLET_CURRENCY_MISMATCH,
 *      MISSING_REFERENCE, REFERENCE_KIND_MISMATCH,
 *      REFERENCE_ATTRIBUTES_MISMATCH, AMOUNT_MISMATCH, IDEMPOTENCY_CONFLICT
 *
 *  DESISTIR (terminal — nenhuma requisição futura vai ajudar):
 *    - INSUFFICIENT_FUNDS, REVERSAL_WOULD_OVERDRAW, REFERENCE_NOT_FOUND,
 *      ALREADY_REVERSED
 *
 *  INTERNO (auditável, não é culpa do provedor):
 *    - INTERNAL_ERROR
 */
export enum FailureCode {
  ValidationError = "VALIDATION_ERROR",
  Unauthenticated = "UNAUTHENTICATED",
  Forbidden = "FORBIDDEN",
  WalletNotFound = "WALLET_NOT_FOUND",
  WalletAlreadyExists = "WALLET_ALREADY_EXISTS",
  TransactionNotFound = "TRANSACTION_NOT_FOUND",
  WalletCurrencyMismatch = "WALLET_CURRENCY_MISMATCH",

  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",

  IdempotencyConflict = "IDEMPOTENCY_CONFLICT",

  MissingReference = "MISSING_REFERENCE",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceKindMismatch = "REFERENCE_KIND_MISMATCH",
  ReferenceAttributesMismatch = "REFERENCE_ATTRIBUTES_MISMATCH",
  AmountMismatch = "AMOUNT_MISMATCH",
  AlreadyReversed = "ALREADY_REVERSED",

  InternalError = "INTERNAL_ERROR",
}

/** Se um provedor poderia se beneficiar de reenviar a mesma requisição. */
export function isRetryable(code: FailureCode): boolean {
  return code === FailureCode.ReferenceNotProcessed;
}
