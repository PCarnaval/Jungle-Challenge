import { DomainError } from "../shared/domain-error";

/** Tentativa de transicionar uma transação que já está em estado terminal. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(
    readonly transactionId: string,
    readonly currentStatus: string,
    readonly attempted: string,
  ) {
    super(
      `Transaction ${transactionId} is in terminal state ${currentStatus}; cannot ${attempted}`,
    );
  }
}

/** `REFUND` / `ROLLBACK` criado sem `referenceExternalTransactionId`. */
export class ReferenceRequiredError extends DomainError {
  readonly code = "REFERENCE_REQUIRED";

  constructor(readonly kind: string) {
    super(`${kind} requires a referenceExternalTransactionId`);
  }
}

/** Um kind voltado ao provedor criado sem contexto de rodada / jogo. */
export class TransactionContextRequiredError extends DomainError {
  readonly code = "TRANSACTION_CONTEXT_REQUIRED";

  constructor(readonly missing: string) {
    super(`Missing required transaction context: ${missing}`);
  }
}

/** `OPENING` é interno — não pode ser submetido via `create`. */
export class OpeningNotSubmittableError extends DomainError {
  readonly code = "OPENING_NOT_SUBMITTABLE";

  constructor() {
    super("OPENING transactions are internal and cannot be submitted via the API or queue");
  }
}

/** O valor da transação deve ser estritamente positivo. */
export class NonPositiveTransactionAmountError extends DomainError {
  readonly code = "NON_POSITIVE_TRANSACTION_AMOUNT";

  constructor() {
    super("Transaction amount must be strictly positive");
  }
}

/** `ledgerDirectionFor` foi chamado para um kind que nunca toca o saldo. */
export class NoLedgerDirectionError extends DomainError {
  readonly code = "NO_LEDGER_DIRECTION";

  constructor(readonly kind: string) {
    super(`${kind} does not produce a ledger movement`);
  }
}
