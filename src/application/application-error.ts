import { FailureCode } from "../domain/wagering/failure-code";

/** Como a camada HTTP / consumidor deve reagir a uma chamada de use case que falhou. */
export type ApplicationErrorKind =
  | "validation" // malformado / não aceitável — 400
  | "conflict" // conflito de idempotência ou de unicidade — 409
  | "not_found" // o agregado referenciado está ausente — 404 / 422
  | "transient"; // falha de infraestrutura retryable — 503

/**
 * Falha determinística de um use case que NÃO é persistida como uma transação
 * REJECTED (essas voltam como um resultado normal carregando um `failureCode`).
 * Tudo aqui só é seguro de retentar se `kind === "transient"`.
 */
export abstract class ApplicationError extends Error {
  abstract readonly failureCode: FailureCode;
  abstract readonly kind: ApplicationErrorKind;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends ApplicationError {
  readonly failureCode: FailureCode;
  readonly kind = "validation" as const;

  constructor(message: string, failureCode: FailureCode = FailureCode.ValidationError) {
    super(message);
    this.failureCode = failureCode;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly failureCode = FailureCode.WalletNotFound;
  readonly kind = "not_found" as const;

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly failureCode = FailureCode.TransactionNotFound;
  readonly kind = "not_found" as const;

  constructor(readonly reference: string) {
    super(`Transaction ${reference} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly failureCode = FailureCode.WalletAlreadyExists;
  readonly kind = "conflict" as const;

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`A wallet already exists for player ${playerId} in ${currency}`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly failureCode = FailureCode.IdempotencyConflict;
  readonly kind = "conflict" as const;

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency-Key ${idempotencyKey} was already used with a different payload`);
  }
}
