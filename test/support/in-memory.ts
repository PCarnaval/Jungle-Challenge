import { Money } from "../../src/domain/money/money";
import { Wallet, type WalletState } from "../../src/domain/wallet/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
  type LedgerEntryState,
} from "../../src/domain/wallet/wallet-ledger-entry";
import {
  WagerTransaction,
  WagerTransactionStatus,
  type WagerTransactionKind,
  type WagerTransactionState,
} from "../../src/domain/wagering/wager-transaction";
import {
  InboxMessage,
  type InboxMessageState,
} from "../../src/domain/messaging/inbox-message";
import {
  OutboxMessage,
  type OutboxMessageState,
} from "../../src/domain/messaging/outbox-message";

import type { Clock, IdGenerator } from "../../src/application/ports/system.ports";
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "../../src/application/ports/repositories.ports";
import {
  UniqueConstraintError,
  type RunOptions,
  type TransactionalRepositories,
  type UnitOfWork,
} from "../../src/application/ports/unit-of-work.port";

// ---------------------------------------------------------------------------
// Portas de sistema determinísticas
// ---------------------------------------------------------------------------

export class FixedClock implements Clock {
  constructor(private current = new Date("2026-01-01T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}

export class SeqIdGenerator implements IdGenerator {
  private n = 0;
  constructor(private readonly prefix = "id") {}
  next(): string {
    this.n += 1;
    return `${this.prefix}-${this.n}`;
  }
}

// ---------------------------------------------------------------------------
// Store em memória (guarda snapshots planos *State, como uma tabela real)
// ---------------------------------------------------------------------------

const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id }), "utf8").toString("base64url");
const decodeCursor = (c: string): { t: string; id: string } =>
  JSON.parse(Buffer.from(c, "base64url").toString("utf8"));

export class InMemoryDb {
  wallets = new Map<string, WalletState>();
  transactions = new Map<string, WagerTransactionState>();
  ledger = new Map<string, LedgerEntryState>();
  inbox = new Map<string, InboxMessageState>();
  outbox = new Map<string, OutboxMessageState>();

  snapshot() {
    return {
      wallets: structuredClone([...this.wallets]),
      transactions: structuredClone([...this.transactions]),
      ledger: structuredClone([...this.ledger]),
      inbox: structuredClone([...this.inbox]),
      outbox: structuredClone([...this.outbox]),
    };
  }

  restore(s: ReturnType<InMemoryDb["snapshot"]>): void {
    this.wallets = new Map(s.wallets);
    this.transactions = new Map(s.transactions);
    this.ledger = new Map(s.ledger);
    this.inbox = new Map(s.inbox);
    this.outbox = new Map(s.outbox);
  }
}

// ---------------------------------------------------------------------------
// Repositórios
// ---------------------------------------------------------------------------

class InMemoryWalletRepository implements WalletRepository {
  constructor(private readonly db: InMemoryDb) {}

  async findById(id: string): Promise<Wallet | null> {
    const s = this.db.wallets.get(id);
    return s ? Wallet.rehydrate(structuredClone(s)) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    for (const s of this.db.wallets.values()) {
      if (s.playerId === playerId && s.currency === currency) {
        return Wallet.rehydrate(structuredClone(s));
      }
    }
    return null;
  }

  async insert(wallet: Wallet): Promise<void> {
    const s = wallet.toState();
    if (this.db.wallets.has(s.id)) {
      throw new UniqueConstraintError("wallet_pkey");
    }
    for (const existing of this.db.wallets.values()) {
      if (existing.playerId === s.playerId && existing.currency === s.currency) {
        throw new UniqueConstraintError("wallet_player_currency_uq");
      }
    }
    this.db.wallets.set(s.id, s);
  }

  async save(wallet: Wallet): Promise<void> {
    const s = wallet.toState();
    if (!this.db.wallets.has(s.id)) throw new Error(`wallet ${s.id} not found for save`);
    this.db.wallets.set(s.id, s);
  }
}

class InMemoryWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly db: InMemoryDb) {}

  private rows(): WagerTransactionState[] {
    return [...this.db.transactions.values()];
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const s = this.db.transactions.get(id);
    return s ? WagerTransaction.rehydrate(structuredClone(s)) : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const s = this.rows().find((r) => r.idempotencyKey === key);
    return s ? WagerTransaction.rehydrate(structuredClone(s)) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const s = this.rows().find(
      (r) => r.providerId === providerId && r.externalTransactionId === externalTransactionId,
    );
    return s ? WagerTransaction.rehydrate(structuredClone(s)) : null;
  }

  async findActiveReversalOf(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    const active = new Set([
      WagerTransactionStatus.Pending,
      WagerTransactionStatus.PendingReference,
      WagerTransactionStatus.Processed,
    ]);
    const s = this.rows().find(
      (r) =>
        r.referenceTransactionId === referenceTransactionId &&
        r.kind === kind &&
        active.has(r.status),
    );
    return s ? WagerTransaction.rehydrate(structuredClone(s)) : null;
  }

  async listDuePendingReference(limit: number, now: Date): Promise<WagerTransaction[]> {
    return this.rows()
      .filter(
        (r) =>
          r.status === WagerTransactionStatus.PendingReference &&
          (r.nextAttemptAt === null || r.nextAttemptAt.getTime() <= now.getTime()),
      )
      .sort((a, b) => (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0))
      .slice(0, limit)
      .map((s) => WagerTransaction.rehydrate(structuredClone(s)));
  }

  async insert(tx: WagerTransaction): Promise<void> {
    const s = tx.toState();
    if (this.db.transactions.has(s.id)) {
      throw new UniqueConstraintError("wager_transaction_pkey");
    }
    for (const existing of this.rows()) {
      if (existing.idempotencyKey === s.idempotencyKey) {
        throw new UniqueConstraintError("wt_idempotency_key_uq");
      }
      if (
        existing.providerId === s.providerId &&
        existing.externalTransactionId === s.externalTransactionId
      ) {
        throw new UniqueConstraintError("wt_provider_external_uq");
      }
    }
    this.db.transactions.set(s.id, s);
  }

  async save(tx: WagerTransaction): Promise<void> {
    const s = tx.toState();
    this.db.transactions.set(s.id, s);
  }
}

class InMemoryLedgerRepository implements LedgerRepository {
  constructor(private readonly db: InMemoryDb) {}

  private rows(): LedgerEntryState[] {
    return [...this.db.ledger.values()];
  }

  async insert(entry: WalletLedgerEntry): Promise<void> {
    const s = entry.toState();
    if (this.db.ledger.has(s.id)) {
      throw new UniqueConstraintError("wle_pkey");
    }
    for (const existing of this.rows()) {
      if (existing.walletId === s.walletId && existing.transactionId === s.transactionId) {
        throw new UniqueConstraintError("wle_wallet_transaction_uq");
      }
    }
    this.db.ledger.set(s.id, s);
  }

  async findByWalletAndTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    const s = this.rows().find(
      (r) => r.walletId === walletId && r.transactionId === transactionId,
    );
    return s ? WalletLedgerEntry.rehydrate(structuredClone(s)) : null;
  }

  async listByWallet(
    walletId: string,
    cursor: string | null,
    limit: number,
  ): Promise<LedgerPage> {
    let rows = this.rows()
      .filter((r) => r.walletId === walletId)
      .sort((a, b) => {
        const t = a.createdAt.getTime() - b.createdAt.getTime();
        return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      rows = rows.filter((r) => {
        const iso = r.createdAt.toISOString();
        return iso > t || (iso === t && r.id > id);
      });
    }

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((s) => WalletLedgerEntry.rehydrate(structuredClone(s))),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async sumSignedByWallet(walletId: string): Promise<Money> {
    const wallet = this.db.wallets.get(walletId);
    if (!wallet) throw new Error(`wallet ${walletId} not found for reconciliation`);
    let acc = Money.zero(wallet.currency);
    for (const r of this.rows()) {
      if (r.walletId !== walletId) continue;
      const m = Money.fromComputed(r.money);
      acc = r.direction === LedgerDirection.Credit ? acc.add(m) : acc.subtract(m);
    }
    return acc;
  }

  async countByWallet(walletId: string): Promise<number> {
    return this.rows().filter((r) => r.walletId === walletId).length;
  }
}

class InMemoryInboxRepository implements InboxRepository {
  constructor(private readonly db: InMemoryDb) {}

  private key(consumerName: string, messageId: string): string {
    return `${consumerName} ${messageId}`;
  }

  async insert(message: InboxMessage): Promise<void> {
    const s = message.toState();
    const k = this.key(s.consumerName, s.messageId);
    if (this.db.inbox.has(k)) {
      throw new UniqueConstraintError("inbox_message_pkey");
    }
    this.db.inbox.set(k, s);
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const s = this.db.inbox.get(this.key(consumerName, messageId));
    return s ? InboxMessage.rehydrate(structuredClone(s)) : null;
  }

  async save(message: InboxMessage): Promise<void> {
    const s = message.toState();
    this.db.inbox.set(this.key(s.consumerName, s.messageId), s);
  }
}

class InMemoryOutboxRepository implements OutboxRepository {
  constructor(private readonly db: InMemoryDb) {}

  private rows(): OutboxMessageState[] {
    return [...this.db.outbox.values()];
  }

  async insert(message: OutboxMessage): Promise<void> {
    const s = message.toState();
    if (this.db.outbox.has(s.id)) {
      throw new UniqueConstraintError("outbox_message_pkey");
    }
    this.db.outbox.set(s.id, s);
  }

  async insertMany(messages: OutboxMessage[]): Promise<void> {
    for (const m of messages) await this.insert(m);
  }

  async claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    return this.rows()
      .filter(
        (r) =>
          r.publishedAt === undefined &&
          (r.nextAttemptAt === undefined || r.nextAttemptAt.getTime() <= now.getTime()),
      )
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, limit)
      .map((s) => OutboxMessage.rehydrate(structuredClone(s)));
  }

  async save(message: OutboxMessage): Promise<void> {
    this.db.outbox.set(message.id, message.toState());
  }

  async countPending(): Promise<number> {
    return this.rows().filter((r) => r.publishedAt === undefined).length;
  }

  async oldestPendingAgeMs(now: Date): Promise<number> {
    const pending = this.rows().filter((r) => r.publishedAt === undefined);
    if (pending.length === 0) return 0;
    const oldest = Math.min(...pending.map((r) => r.occurredAt.getTime()));
    return Math.max(0, now.getTime() - oldest);
  }
}

// ---------------------------------------------------------------------------
// Unit of Work
// ---------------------------------------------------------------------------

export class InMemoryUnitOfWork implements UnitOfWork {
  readonly db = new InMemoryDb();

  async run<T>(
    _options: RunOptions,
    work: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.db.snapshot();
    try {
      return await work(this.repositories());
    } catch (err) {
      this.db.restore(snapshot); // desfaz tudo (rollback)
      throw err;
    }
  }

  repositories(): TransactionalRepositories {
    return {
      wallets: new InMemoryWalletRepository(this.db),
      transactions: new InMemoryWagerTransactionRepository(this.db),
      ledger: new InMemoryLedgerRepository(this.db),
      inbox: new InMemoryInboxRepository(this.db),
      outbox: new InMemoryOutboxRepository(this.db),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers de asserção
// ---------------------------------------------------------------------------

export function ledgerEntriesOf(db: InMemoryDb, walletId: string): WalletLedgerEntry[] {
  return [...db.ledger.values()]
    .filter((r) => r.walletId === walletId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((s) => WalletLedgerEntry.rehydrate(structuredClone(s)));
}

export function transactionsOf(db: InMemoryDb): WagerTransaction[] {
  return [...db.transactions.values()].map((s) =>
    WagerTransaction.rehydrate(structuredClone(s)),
  );
}

export function outboxOf(db: InMemoryDb): OutboxMessage[] {
  return [...db.outbox.values()].map((s) => OutboxMessage.rehydrate(structuredClone(s)));
}

export function replayLedgerBalance(db: InMemoryDb, walletId: string): Money {
  const wallet = db.wallets.get(walletId);
  if (!wallet) throw new Error(`wallet ${walletId} not found`);
  let acc = Money.zero(wallet.currency);
  for (const e of ledgerEntriesOf(db, walletId)) acc = acc.add(e.signedAmount());
  return acc;
}
