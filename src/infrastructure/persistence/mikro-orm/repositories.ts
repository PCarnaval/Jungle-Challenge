import {
  LockMode,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";

import { Money } from "../../../domain/money/money";
import type { Wallet } from "../../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from "../../../domain/wagering/wager-transaction";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";

import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "../../../application/ports/repositories.ports";
import { UniqueConstraintError } from "../../../application/ports/unit-of-work.port";

import {
  InboxMessageEntity,
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
} from "./entities";
import {
  inboxToDomain,
  inboxToNewEntity,
  ledgerEntryToDomain,
  ledgerEntryToNewEntity,
  outboxMutableFields,
  outboxToDomain,
  outboxToNewEntity,
  transactionMutableFields,
  transactionToDomain,
  transactionToNewEntity,
  walletToDomain,
  walletToNewEntity,
} from "./mappers";

/** A checagem de optimistic lock falhou mesmo com o FOR UPDATE em mãos — corrupção de dados. */
export class ConcurrentModificationError extends Error {
  constructor(readonly entity: string, readonly id: string) {
    super(`Concurrent modification of ${entity} ${id}`);
    this.name = "ConcurrentModificationError";
  }
}

function rethrowUnique(err: unknown): never {
  if (err instanceof UniqueConstraintViolationException) {
    throw new UniqueConstraintError(
      (err as { constraint?: string }).constraint ?? "unknown",
      err.message,
    );
  }
  throw err;
}

const encodeCursor = (t: Date, id: string): string =>
  Buffer.from(JSON.stringify({ t: t.toISOString(), id }), "utf8").toString("base64url");

const decodeCursor = (cursor: string): { t: string; id: string } =>
  JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t: string; id: string };

// ===========================================================================
// Wallet
// ===========================================================================

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const e = await this.em.findOne(WalletEntity, { id });
    return e ? walletToDomain(e) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const e = await this.em.findOne(WalletEntity, { playerId, currency });
    return e ? walletToDomain(e) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletEntity, walletToNewEntity(wallet));
    } catch (err) {
      rethrowUnique(err);
    }
  }

  /**
   * Persiste balance / version / updatedAt. Protegido com a `version` anterior
   * como defesa em profundidade, mesmo com a linha já travada FOR UPDATE.
   */
  async save(wallet: Wallet): Promise<void> {
    const s = wallet.toState();
    const affected = await this.em.nativeUpdate(
      WalletEntity,
      { id: s.id, version: s.version - 1 },
      { balance: s.balance.amount, version: s.version, updatedAt: s.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrentModificationError("wallet", s.id);
    }
  }
}

// ===========================================================================
// WagerTransaction
// ===========================================================================

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const e = await this.em.findOne(WagerTransactionEntity, { id });
    return e ? transactionToDomain(e) : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const e = await this.em.findOne(WagerTransactionEntity, { idempotencyKey: key });
    return e ? transactionToDomain(e) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const e = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    return e ? transactionToDomain(e) : null;
  }

  async findActiveReversalOf(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    const e = await this.em.findOne(WagerTransactionEntity, {
      referenceTransactionId,
      kind,
      status: {
        $in: [
          WagerTransactionStatus.Pending,
          WagerTransactionStatus.PendingReference,
          WagerTransactionStatus.Processed,
        ],
      },
    });
    return e ? transactionToDomain(e) : null;
  }

  async listDuePendingReference(limit: number, now: Date): Promise<WagerTransaction[]> {
    const rows = await this.em.find(
      WagerTransactionEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      { orderBy: { nextAttemptAt: "asc", createdAt: "asc" }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return rows.map(transactionToDomain);
  }

  async insert(tx: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionEntity, transactionToNewEntity(tx));
    } catch (err) {
      rethrowUnique(err);
    }
  }

  async save(tx: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(WagerTransactionEntity, { id: tx.id }, transactionMutableFields(tx));
  }
}

// ===========================================================================
// Ledger
// ===========================================================================

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    try {
      await this.em.insert(WalletLedgerEntryEntity, ledgerEntryToNewEntity(entry));
    } catch (err) {
      rethrowUnique(err);
    }
  }

  async findByWalletAndTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    const e = await this.em.findOne(WalletLedgerEntryEntity, { walletId, transactionId });
    return e ? ledgerEntryToDomain(e) : null;
  }

  async listByWallet(
    walletId: string,
    cursor: string | null,
    limit: number,
  ): Promise<LedgerPage> {
    const qb = this.em
      .createQueryBuilder(WalletLedgerEntryEntity, "e")
      .where({ walletId })
      .orderBy({ createdAt: "asc", id: "asc" })
      .limit(limit + 1);

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere("(e.created_at, e.id) > (?, ?)", [t, id]);
    }

    const rows = await qb.getResultList();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      entries: page.map(ledgerEntryToDomain),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async sumSignedByWallet(walletId: string): Promise<Money> {
    const rows = await this.em.getConnection().execute<Array<{ currency: string; s: string }>>(
      `select w.currency as currency,
              coalesce(sum(case when le.direction = 'CREDIT' then le.amount else -le.amount end), 0) as s
         from wallet w
         left join wallet_ledger_entry le on le.wallet_id = w.id
        where w.id = ?
        group by w.currency`,
      [walletId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Wallet ${walletId} not found for reconciliation`);
    }
    return Money.fromComputed({ amount: String(row.s), currency: row.currency });
  }

  async countByWallet(walletId: string): Promise<number> {
    return this.em.count(WalletLedgerEntryEntity, { walletId });
  }
}

// ===========================================================================
// Inbox
// ===========================================================================

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: InboxMessage): Promise<void> {
    try {
      await this.em.insert(InboxMessageEntity, inboxToNewEntity(message));
    } catch (err) {
      rethrowUnique(err);
    }
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const e = await this.em.findOne(InboxMessageEntity, { consumerName, messageId });
    return e ? inboxToDomain(e) : null;
  }

  async save(message: InboxMessage): Promise<void> {
    const s = message.toState();
    await this.em.nativeUpdate(
      InboxMessageEntity,
      { consumerName: s.consumerName, messageId: s.messageId },
      { processedAt: s.processedAt ?? null },
    );
  }
}

// ===========================================================================
// Outbox
// ===========================================================================

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: OutboxMessage): Promise<void> {
    try {
      await this.em.insert(OutboxMessageEntity, outboxToNewEntity(message));
    } catch (err) {
      rethrowUnique(err);
    }
  }

  async insertMany(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    try {
      await this.em.insertMany(
        OutboxMessageEntity,
        messages.map((m) => outboxToNewEntity(m)),
      );
    } catch (err) {
      rethrowUnique(err);
    }
  }

  async claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxMessageEntity,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        orderBy: { occurredAt: "asc" },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // equivale a FOR UPDATE SKIP LOCKED
      },
    );
    return rows.map(outboxToDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(OutboxMessageEntity, { id: message.id }, outboxMutableFields(message));
  }

  async countPending(): Promise<number> {
    return this.em.count(OutboxMessageEntity, { publishedAt: null });
  }

  async oldestPendingAgeMs(now: Date): Promise<number> {
    const e = await this.em.findOne(
      OutboxMessageEntity,
      { publishedAt: null },
      { orderBy: { occurredAt: "asc" } },
    );
    return e ? Math.max(0, now.getTime() - e.occurredAt.getTime()) : 0;
  }
}
