import { Wallet } from "../../../domain/wallet/wallet";
import {
  WalletLedgerEntry,
  type LedgerDirection,
} from "../../../domain/wallet/wallet-ledger-entry";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import type { FailureCode } from "../../../domain/wagering/failure-code";
import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import type { IntegrationEventEnvelope } from "../../../domain/messaging/integration-event";
import {
  InboxMessageEntity,
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
} from "./entities";

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export function walletToDomain(e: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: e.id,
    playerId: e.playerId,
    currency: e.currency,
    balance: { amount: e.balance, currency: e.currency },
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  });
}

export function walletToNewEntity(w: Wallet): WalletEntity {
  const s = w.toState();
  const e = new WalletEntity();
  e.id = s.id;
  e.playerId = s.playerId;
  e.currency = s.currency;
  e.balance = s.balance.amount;
  e.version = s.version;
  e.createdAt = s.createdAt;
  e.updatedAt = s.updatedAt;
  return e;
}

// ---------------------------------------------------------------------------
// WagerTransaction
// ---------------------------------------------------------------------------

export function transactionToDomain(e: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: e.id,
    providerId: e.providerId,
    externalTransactionId: e.externalTransactionId,
    idempotencyKey: e.idempotencyKey,
    payloadHash: e.payloadHash,
    walletId: e.walletId,
    playerId: e.playerId,
    roundId: e.roundId,
    gameId: e.gameId,
    kind: e.kind as WagerTransactionKind,
    money: { amount: e.amount, currency: e.currency },
    referenceExternalTransactionId: e.referenceExternalTransactionId,
    createdAt: e.createdAt,
    status: e.status as WagerTransactionStatus,
    referenceTransactionId: e.referenceTransactionId,
    failureCode: (e.failureCode as FailureCode | null) ?? null,
    processedAt: e.processedAt,
    referenceAttempts: e.referenceAttempts,
    nextAttemptAt: e.nextAttemptAt,
    pendingReferenceSince: e.pendingReferenceSince,
    observedBalance: e.observedBalance ? { amount: e.observedBalance, currency: e.currency } : null,
  });
}

export function transactionToNewEntity(tx: WagerTransaction): WagerTransactionEntity {
  const s = tx.toState();
  const e = new WagerTransactionEntity();
  e.id = s.id;
  e.providerId = s.providerId;
  e.externalTransactionId = s.externalTransactionId;
  e.idempotencyKey = s.idempotencyKey;
  e.payloadHash = s.payloadHash;
  e.walletId = s.walletId;
  e.playerId = s.playerId;
  e.roundId = s.roundId;
  e.gameId = s.gameId;
  e.kind = s.kind;
  e.amount = s.money.amount;
  e.currency = s.money.currency;
  e.referenceExternalTransactionId = s.referenceExternalTransactionId;
  e.referenceTransactionId = s.referenceTransactionId;
  e.status = s.status;
  e.failureCode = s.failureCode;
  e.referenceAttempts = s.referenceAttempts;
  e.nextAttemptAt = s.nextAttemptAt;
  e.pendingReferenceSince = s.pendingReferenceSince;
  e.observedBalance = s.observedBalance ? s.observedBalance.amount : null;
  e.createdAt = s.createdAt;
  e.processedAt = s.processedAt;
  return e;
}

/** Campos mutáveis de uma linha de transação existente (nomes de propriedade, para nativeUpdate). */
export function transactionMutableFields(tx: WagerTransaction): Record<string, unknown> {
  const s = tx.toState();
  return {
    status: s.status,
    failureCode: s.failureCode,
    referenceTransactionId: s.referenceTransactionId,
    referenceAttempts: s.referenceAttempts,
    nextAttemptAt: s.nextAttemptAt,
    pendingReferenceSince: s.pendingReferenceSince,
    processedAt: s.processedAt,
    observedBalance: s.observedBalance ? s.observedBalance.amount : null,
  };
}

// ---------------------------------------------------------------------------
// WalletLedgerEntry
// ---------------------------------------------------------------------------

export function ledgerEntryToDomain(e: WalletLedgerEntryEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction as LedgerDirection,
    money: { amount: e.amount, currency: e.currency },
    balanceBefore: { amount: e.balanceBefore, currency: e.currency },
    balanceAfter: { amount: e.balanceAfter, currency: e.currency },
    createdAt: e.createdAt,
  });
}

export function ledgerEntryToNewEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
  const s = entry.toState();
  const e = new WalletLedgerEntryEntity();
  e.id = s.id;
  e.walletId = s.walletId;
  e.transactionId = s.transactionId;
  e.direction = s.direction;
  e.amount = s.money.amount;
  e.currency = s.money.currency;
  e.balanceBefore = s.balanceBefore.amount;
  e.balanceAfter = s.balanceAfter.amount;
  e.createdAt = s.createdAt;
  return e;
}

// ---------------------------------------------------------------------------
// Inbox / Outbox
// ---------------------------------------------------------------------------

export function inboxToDomain(e: InboxMessageEntity): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: e.messageId,
    consumerName: e.consumerName,
    payloadHash: e.payloadHash,
    receivedAt: e.receivedAt,
    processedAt: e.processedAt ?? undefined,
  });
}

export function inboxToNewEntity(m: InboxMessage): InboxMessageEntity {
  const s = m.toState();
  const e = new InboxMessageEntity();
  e.consumerName = s.consumerName;
  e.messageId = s.messageId;
  e.payloadHash = s.payloadHash;
  e.receivedAt = s.receivedAt;
  e.processedAt = s.processedAt ?? null;
  return e;
}

export function outboxToDomain(e: OutboxMessageEntity): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: e.id,
    aggregateId: e.aggregateId,
    eventType: e.eventType,
    payload: e.payload as unknown as IntegrationEventEnvelope<unknown>,
    occurredAt: e.occurredAt,
    attempts: e.attempts,
    nextAttemptAt: e.nextAttemptAt ?? undefined,
    publishedAt: e.publishedAt ?? undefined,
  });
}

export function outboxToNewEntity(m: OutboxMessage): OutboxMessageEntity {
  const s = m.toState();
  const e = new OutboxMessageEntity();
  e.id = s.id;
  e.aggregateId = s.aggregateId;
  e.eventType = s.eventType;
  e.payload = s.payload as unknown as Record<string, unknown>;
  e.occurredAt = s.occurredAt;
  e.attempts = s.attempts;
  e.nextAttemptAt = s.nextAttemptAt ?? null;
  e.publishedAt = s.publishedAt ?? null;
  e.createdAt = s.occurredAt;
  return e;
}

export function outboxMutableFields(m: OutboxMessage): Record<string, unknown> {
  const s = m.toState();
  return {
    attempts: s.attempts,
    nextAttemptAt: s.nextAttemptAt ?? null,
    publishedAt: s.publishedAt ?? null,
  };
}
