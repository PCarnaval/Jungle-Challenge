import { Money, type MoneyProps } from "../money/money";
import { LedgerDirection } from "../wallet/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import {
  InvalidTransactionStateError,
  NoLedgerDirectionError,
  NonPositiveTransactionAmountError,
  OpeningNotSubmittableError,
  ReferenceRequiredError,
  TransactionContextRequiredError,
} from "./wager-transaction.errors";

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca submetido externamente. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = "PENDING",
  /** Aguardando a transação referenciada existir / ser processada. */
  PendingReference = "PENDING_REFERENCE",
  /** Aplicada (terminal). */
  Processed = "PROCESSED",
  /** Violação de regra de negócio (terminal). */
  Rejected = "REJECTED",
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = "FAILED",
}

const REVERSAL_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const DEFAULT_REFERENCE_BACKOFF_MS = 2000;
const MAX_REFERENCE_BACKOFF_MS = 60 * 60 * 1000; // 1h

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id da transação referenciada no provedor — não o id interno. */
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  processedAt: Date | null;
  referenceAttempts: number;
  nextAttemptAt: Date | null;
  pendingReferenceSince: Date | null;
  /** Saldo da wallet observado no processamento — replicado tal e qual (README item 7.7). */
  observedBalance: MoneyProps | null;
}

/**
 * Uma única operação enviada por um provedor (ou o crédito interno de OPENING).
 *
 * Ciclo de vida:
 *   PENDING ─┬─▶ PROCESSED         (markProcessed)
 *            ├─▶ PENDING_REFERENCE (markPendingReference) ─┬─▶ PROCESSED
 *            │                                             ├─▶ REJECTED
 *            │                                             └─▶ FAILED
 *            ├─▶ REJECTED          (reject)
 *            └─▶ FAILED            (fail)
 *
 * PROCESSED / REJECTED / FAILED são terminais — qualquer transição além disso é
 * erro de programação e levanta InvalidTransactionStateError.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | null,
    public readonly gameId: string | null,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | null,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | null,
    private _failureCode: FailureCode | null,
    private _processedAt: Date | null,
    private _referenceAttempts: number,
    private _nextAttemptAt: Date | null,
    private _pendingReferenceSince: Date | null,
    private _observedBalance: Money | null,
  ) {}

  // --------------------------------------------------------------------------
  // Factories
  // --------------------------------------------------------------------------

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new OpeningNotSubmittableError();
    }
    if (!props.money.isPositive()) {
      throw new NonPositiveTransactionAmountError();
    }
    if (!props.roundId) throw new TransactionContextRequiredError("roundId");
    if (!props.gameId) throw new TransactionContextRequiredError("gameId");
    if (REVERSAL_KINDS.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new ReferenceRequiredError(props.kind);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId ?? null,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
    );
  }

  /**
   * Crédito interno de OPENING. Nasce em PENDING; o use case CreateWallet o marca
   * PROCESSED na mesma transação SQL da wallet e do lançamento no ledger.
   */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new NonPositiveTransactionAmountError();
    }
    const externalId = `opening:${props.walletId}`;
    return new WagerTransaction(
      props.id,
      "internal",
      externalId,
      `internal:${externalId}`,
      `opening:${props.walletId}:${props.money.toString()}`,
      props.walletId,
      props.playerId,
      null,
      null,
      WagerTransactionKind.Opening,
      props.money,
      null,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
    );
  }

  /** Reconstrução a partir da persistência — NÃO revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.referenceAttempts,
      state.nextAttemptAt,
      state.pendingReferenceSince,
      state.observedBalance ? Money.fromComputed(state.observedBalance) : null,
    );
  }

  // --------------------------------------------------------------------------
  // Acessores
  // --------------------------------------------------------------------------

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId ?? undefined;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode ?? undefined;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ?? undefined;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ?? undefined;
  }

  get pendingReferenceSince(): Date | undefined {
    return this._pendingReferenceSince ?? undefined;
  }

  /** Saldo da wallet observado no processamento (README item 7.7). */
  get observedBalance(): Money | undefined {
    return this._observedBalance ?? undefined;
  }

  // --------------------------------------------------------------------------
  // Transições
  // --------------------------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId ?? null;
    this._failureCode = null;
    this._processedAt = at;
    this._nextAttemptAt = null;
  }

  markPendingReference(now?: Date): void {
    this.assertNotTerminal("markPendingReference");
    this._status = WagerTransactionStatus.PendingReference;
    if (now && this._pendingReferenceSince === null) {
      this._pendingReferenceSince = now;
    }
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = null;
    this._nextAttemptAt = null;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = null;
  }

  /**
   * Registra uma tentativa de resolução de referência que falhou e agenda a
   * próxima com backoff exponencial. Quem chama decide (via
   * {@link shouldGiveUpOnReference}) quando fazer `reject` no lugar.
   */
  scheduleReferenceRetry(now: Date, baseBackoffMs: number = DEFAULT_REFERENCE_BACKOFF_MS): void {
    this._referenceAttempts += 1;
    const delay = Math.min(
      baseBackoffMs * 2 ** (this._referenceAttempts - 1),
      MAX_REFERENCE_BACKOFF_MS,
    );
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  /**
   * Registra o saldo da wallet observado enquanto esta transação foi aplicada,
   * para que um replay idempotente posterior retorne exatamente o mesmo saldo
   * (README item 7.7). Guardado apenas quando o saldo observado compartilha a
   * moeda da transação.
   */
  recordObservedBalance(balance: Money): void {
    this._observedBalance = balance.currency === this.money.currency ? balance : null;
  }

  // --------------------------------------------------------------------------
  // Consultas de domínio
  // --------------------------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  isProcessed(): boolean {
    return this._status === WagerTransactionStatus.Processed;
  }

  isPendingReference(): boolean {
    return this._status === WagerTransactionStatus.PendingReference;
  }

  /** false para LOSS — registra um resultado sem mover o saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Desiste quando o limite de tentativas OU o TTL é ultrapassado. */
  shouldGiveUpOnReference(now: Date, maxAttempts: number, ttlMs: number): boolean {
    if (this._referenceAttempts >= maxAttempts) return true;
    if (this._pendingReferenceSince !== null) {
      return now.getTime() - this._pendingReferenceSince.getTime() >= ttlMs;
    }
    return false;
  }

  /**
   * Direção de ledger que esta transação produz.
   * ROLLBACK é o inverso da sua referência, então a referência deve ser fornecida.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new ReferenceRequiredError(this.kind);
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new NoLedgerDirectionError(this.kind);
      default: {
        const _exhaustive: never = this.kind;
        throw new NoLedgerDirectionError(String(_exhaustive));
      }
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money.toJSON(),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      referenceAttempts: this._referenceAttempts,
      nextAttemptAt: this._nextAttemptAt,
      pendingReferenceSince: this._pendingReferenceSince,
      observedBalance: this._observedBalance ? this._observedBalance.toJSON() : null,
    };
  }

  // --------------------------------------------------------------------------
  // Internos
  // --------------------------------------------------------------------------

  private assertNotTerminal(attempted: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attempted);
    }
  }
}
