import { Money, type MoneyProps } from "../money/money";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "./wallet-ledger-entry";
import {
  InsufficientFundsError,
  NegativeOpeningBalanceError,
  NonPositiveMovementError,
  ReversalWouldOverdrawError,
  WalletCurrencyMismatchError,
} from "./wallet.errors";

/** Formato plano persistido — usado só por `rehydrate` / `toState`. */
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now?: Date;
}

export interface MovementProps {
  /** Id da WagerTransaction que causa este movimento. */
  transactionId: string;
  /** Id pré-alocado do lançamento de ledger que será produzido. */
  ledgerEntryId: string;
  amount: Money;
  at: Date;
}

/**
 * Aggregate root. É dona do saldo e garante que toda mudança de saldo é
 * espelhada por exatamente um lançamento no ledger (e vice-versa).
 *
 * A concorrência (prevenção de lost update) é imposta FORA do agregado, pelo
 * boundary transacional: a linha da wallet é travada `FOR UPDATE` antes de ser
 * reidratada, e uma constraint `CHECK (balance >= 0)` mais a coluna `version`
 * sustentam os invariantes no nível do schema. Ver ARCHITECTURE.md item
 * Concorrência.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  // --------------------------------------------------------------------------
  // Factories
  // --------------------------------------------------------------------------

  /**
   * Abre uma wallet. `version` começa em 1 e já contabiliza o saldo de abertura
   * (exemplo do item 9 do enunciado: uma wallet criada com saldo 1000.00 retorna
   * `version: 1`). Quando o saldo de abertura é positivo, quem chama também deve
   * persistir a transação `OPENING` correspondente e o lançamento de ledger
   * retornado por {@link openingLedgerEntry} — tudo na mesma transação SQL.
   */
  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new NegativeOpeningBalanceError();
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrução a partir da persistência — NÃO revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  // --------------------------------------------------------------------------
  // Acessores
  // --------------------------------------------------------------------------

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  hasOpeningBalance(): boolean {
    return this._balance.isPositive();
  }

  // --------------------------------------------------------------------------
  // Comportamento
  // --------------------------------------------------------------------------

  /**
   * O lançamento `CREDIT` que espelha um saldo de abertura positivo. Retorna
   * `undefined` quando a wallet abriu em zero. NÃO incrementa `version` — o saldo
   * de abertura é considerado parte da construção (ver {@link open}).
   */
  openingLedgerEntry(params: {
    transactionId: string;
    ledgerEntryId: string;
    at: Date;
  }): WalletLedgerEntry | undefined {
    if (!this._balance.isPositive()) {
      return undefined;
    }
    return WalletLedgerEntry.create({
      id: params.ledgerEntryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: params.at,
    });
  }

  /**
   * Aplica um débito. Muta o saldo, incrementa `version` e retorna o lançamento
   * de ledger que deve ser persistido atomicamente com a wallet.
   *
   * @param params.reversal quando true, um saldo negativo levanta
   *   {@link ReversalWouldOverdrawError} em vez de {@link InsufficientFundsError}.
   */
  debit(params: MovementProps & { reversal?: boolean }): WalletLedgerEntry {
    this.assertSameCurrency(params.amount);
    if (!params.amount.isPositive()) {
      throw new NonPositiveMovementError();
    }
    const before = this._balance;
    const after = before.subtract(params.amount);
    if (after.isNegative()) {
      throw params.reversal
        ? new ReversalWouldOverdrawError(this.id)
        : new InsufficientFundsError(this.id);
    }
    const entry = WalletLedgerEntry.create({
      id: params.ledgerEntryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Debit,
      money: params.amount,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: params.at,
    });
    this.applyMovement(after, params.at);
    return entry;
  }

  /**
   * Aplica um crédito. Muta o saldo, incrementa `version` e retorna o lançamento
   * de ledger que deve ser persistido atomicamente com a wallet.
   */
  credit(params: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(params.amount);
    if (!params.amount.isPositive()) {
      throw new NonPositiveMovementError();
    }
    const before = this._balance;
    const after = before.add(params.amount);
    const entry = WalletLedgerEntry.create({
      id: params.ledgerEntryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Credit,
      money: params.amount,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: params.at,
    });
    this.applyMovement(after, params.at);
    return entry;
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance.toJSON(),
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  // --------------------------------------------------------------------------
  // Internos
  // --------------------------------------------------------------------------

  private applyMovement(newBalance: Money, at: Date): void {
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new WalletCurrencyMismatchError(this.currency, money.currency);
    }
  }
}
