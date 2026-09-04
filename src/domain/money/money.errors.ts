import { DomainError } from "../shared/domain-error";

export class InvalidMoneyAmountError extends DomainError {
  readonly code = "INVALID_MONEY_AMOUNT";

  constructor(
    readonly received: unknown,
    readonly reason: string,
  ) {
    super(`Invalid money amount (${reason}): ${JSON.stringify(received)}`);
  }
}

export class InvalidCurrencyError extends DomainError {
  readonly code = "INVALID_CURRENCY";

  constructor(readonly received: unknown) {
    super(`Invalid ISO-4217 currency code: ${JSON.stringify(received)}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`Currency mismatch: cannot operate on ${left} and ${right}`);
  }
}
