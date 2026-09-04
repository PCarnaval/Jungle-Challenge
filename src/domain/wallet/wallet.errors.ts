import { DomainError } from "../shared/domain-error";

/** Um `BET` (ou qualquer débito primário) que o saldo não cobre. */
export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} has insufficient funds for this debit`);
  }
}

/**
 * Uma reversão (`ROLLBACK` de um `WIN`, etc.) cuja perna de débito empurraria o
 * saldo para baixo de zero. Operacionalmente diferente de uma aposta comum sem
 * saldo — a regra 9 do item 7 do enunciado exige um failure code distinto.
 */
export class ReversalWouldOverdrawError extends DomainError {
  readonly code = "REVERSAL_WOULD_OVERDRAW";

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} would go negative if this reversal were applied`);
  }
}

/** A moeda da operação difere da moeda da wallet. */
export class WalletCurrencyMismatchError extends DomainError {
  readonly code = "WALLET_CURRENCY_MISMATCH";

  constructor(
    readonly walletCurrency: string,
    readonly operationCurrency: string,
  ) {
    super(
      `Operation currency ${operationCurrency} does not match wallet currency ${walletCurrency}`,
    );
  }
}

/** Um movimento no ledger deve ser sempre estritamente positivo; o sinal vem da direction. */
export class NonPositiveMovementError extends DomainError {
  readonly code = "NON_POSITIVE_MOVEMENT";

  constructor() {
    super("A ledger movement amount must be strictly positive");
  }
}

/** `balanceBefore ± money !== balanceAfter` — o lançamento do ledger não fecha. */
export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = "UNBALANCED_LEDGER_ENTRY";

  constructor() {
    super("Ledger entry arithmetic is inconsistent (balanceBefore ± money !== balanceAfter)");
  }
}

/** Um saldo de abertura negativo foi passado para `Wallet.open`. */
export class NegativeOpeningBalanceError extends DomainError {
  readonly code = "NEGATIVE_OPENING_BALANCE";

  constructor() {
    super("Opening balance cannot be negative");
  }
}
