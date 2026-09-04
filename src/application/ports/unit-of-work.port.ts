import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "./repositories.ports";

/** Repositórios ligados a uma transação SQL em andamento. */
export interface TransactionalRepositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface RunOptions {
  /**
   * Trava esta linha da wallet com `FOR UPDATE` antes do callback rodar. É o
   * ponto de serialização por wallet — a unidade de concorrência (README item 8).
   */
  lockWallet?: string;
  /** Rótulo para tracing / métricas. */
  name?: string;
}

/**
 * O boundary atômico. `work` roda dentro de uma única transação SQL; todo
 * repositório que ele recebe escreve nessa transação. Commit em caso de sucesso,
 * rollback em caso de throw. Linha do inbox, mudança financeira, lançamento do
 * ledger e linhas do outbox commitam todos juntos ou nada (README item 11).
 */
export interface UnitOfWork {
  run<T>(
    options: RunOptions,
    work: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T>;
}

/** Lançado pelos adaptadores quando uma constraint de unicidade é violada (races de idempotência). */
export class UniqueConstraintError extends Error {
  constructor(
    readonly constraint: string,
    readonly detail?: string,
  ) {
    super(`Unique constraint violated: ${constraint}${detail ? ` (${detail})` : ""}`);
    this.name = "UniqueConstraintError";
  }
}

/** Lançado pelos adaptadores em falhas de infraestrutura retryable (deadlock, conexão resetada, broker 5xx). */
export class TransientInfrastructureError extends Error {
  constructor(
    message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
    this.name = "TransientInfrastructureError";
  }
}
