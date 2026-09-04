import type { Money } from "../../domain/money/money";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import type {
  WagerTransaction,
  WagerTransactionKind,
} from "../../domain/wagering/wager-transaction";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  /** Insere uma wallet recém-aberta. Violação de unicidade em (player_id, currency) => conflito. */
  insert(wallet: Wallet): Promise<void>;
  /** Persiste balance / version / updatedAt de uma wallet existente. */
  save(wallet: Wallet): Promise<void>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  findByWalletAndTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | null>;
  /** Paginação por cursor opaco e estável, ordenada por (created_at, id). */
  listByWallet(walletId: string, cursor: string | null, limit: number): Promise<LedgerPage>;
  /** Soma dos movimentos com sinal (crédito +, débito -) — usada pela reconciliação. */
  sumSignedByWallet(walletId: string): Promise<Money>;
  countByWallet(walletId: string): Promise<number>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  /** Também usada para resolver uma referência por (providerId, referenceExternalTransactionId). */
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  /** Um REFUND/ROLLBACK existente de `referenceTransactionId` que não está REJECTED/FAILED. */
  findActiveReversalOf(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null>;
  /** Linhas PENDING_REFERENCE cujo next_attempt_at já venceu. */
  listDuePendingReference(limit: number, now: Date): Promise<WagerTransaction[]>;
  insert(tx: WagerTransaction): Promise<void>;
  save(tx: WagerTransaction): Promise<void>;
}

export interface InboxRepository {
  /** Insere a linha de dedup. Rejeita com UniqueConstraintError se ela já existe. */
  insert(message: InboxMessage): Promise<void>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  save(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
  insertMany(messages: OutboxMessage[]): Promise<void>;
  /** Linhas vencidas e não publicadas, travadas com FOR UPDATE SKIP LOCKED. */
  claimDue(limit: number, now: Date): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  countPending(): Promise<number>;
  /** Idade em ms da linha não publicada mais antiga (outbox lag), ou 0 se não houver. */
  oldestPendingAgeMs(now: Date): Promise<number>;
}
