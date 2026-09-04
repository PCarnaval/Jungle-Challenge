import type { Wallet } from "../../domain/wallet/wallet";
import { LedgerDirection } from "../../domain/wallet/wallet-ledger-entry";
import {
  InsufficientFundsError,
  ReversalWouldOverdrawError,
  WalletCurrencyMismatchError,
} from "../../domain/wallet/wallet.errors";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../domain/wagering/wager-transaction";
import { FailureCode } from "../../domain/wagering/failure-code";
import type {
  EventContext,
  IntegrationEvent,
} from "../../domain/messaging/integration-event";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/messaging/events";
import { OutboxMessage } from "../../domain/messaging/outbox-message";

import type { IdGenerator } from "../ports/system.ports";
import type { TransactionalRepositories } from "../ports/unit-of-work.port";

/** Tudo que os passos compartilhados precisam para montar eventos e ids de forma consistente. */
export interface ProcessingContext {
  now: Date;
  correlationId: string;
  causationId?: string;
  ids: IdGenerator;
}

export function eventContext(ctx: ProcessingContext): EventContext {
  return {
    eventId: ctx.ids.next(),
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.now,
  };
}

/** Mapeia um erro de domínio da wallet levantado durante a aplicação para um failure code estável. */
export function toFailureCode(err: unknown): FailureCode | null {
  if (err instanceof InsufficientFundsError) return FailureCode.InsufficientFunds;
  if (err instanceof ReversalWouldOverdrawError) return FailureCode.ReversalWouldOverdraw;
  if (err instanceof WalletCurrencyMismatchError) return FailureCode.WalletCurrencyMismatch;
  return null;
}

const ROLLBACK_REFERENCE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

/**
 * A referência existe e está PROCESSED — ela é um alvo válido para `tx`?
 * (Regras 2, 3 e 5 do item 7 do enunciado.) Retorna um failure code quando
 * inválida, `null` quando a reversão pode prosseguir.
 */
export function validateReferenceMatch(
  tx: WagerTransaction,
  reference: WagerTransaction,
): FailureCode | null {
  if (tx.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
    return FailureCode.ReferenceKindMismatch;
  }
  if (
    tx.kind === WagerTransactionKind.Rollback &&
    !ROLLBACK_REFERENCE_KINDS.has(reference.kind)
  ) {
    return FailureCode.ReferenceKindMismatch;
  }
  if (
    reference.playerId !== tx.playerId ||
    reference.walletId !== tx.walletId ||
    reference.roundId !== tx.roundId ||
    reference.money.currency !== tx.money.currency
  ) {
    return FailureCode.ReferenceAttributesMismatch;
  }
  if (!reference.money.equals(tx.money)) {
    return FailureCode.AmountMismatch;
  }
  return null;
}

/**
 * Aplica uma transação aceita à wallet TRAVADA: move o saldo, escreve exatamente
 * um lançamento no ledger (nenhum para LOSS), marca como PROCESSED, registra o
 * saldo observado e salva. Retorna os eventos de integração a enfileirar.
 *
 * Relança os erros de domínio da wallet (saldo insuficiente / reversão que
 * estouraria o saldo / conflito de moeda); quem chama transforma isso num
 * resultado REJECTED.
 */
export async function applyAcceptedTransaction(
  repos: TransactionalRepositories,
  wallet: Wallet,
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  ctx: ProcessingContext,
): Promise<IntegrationEvent<unknown>[]> {
  const events: IntegrationEvent<unknown>[] = [];

  if (!tx.affectsBalance()) {
    // LOSS — registrada, sem lançamento no ledger, sem WalletBalanceChanged.
    tx.markProcessed(undefined, ctx.now);
    tx.recordObservedBalance(wallet.balance);
    await repos.transactions.save(tx);
    events.push(WagerTransactionProcessed.from(tx, eventContext(ctx)));
    return events;
  }

  const direction = tx.ledgerDirectionFor(reference);
  const movement = {
    transactionId: tx.id,
    ledgerEntryId: ctx.ids.next(),
    amount: tx.money,
    at: ctx.now,
  };
  const entry =
    direction === LedgerDirection.Debit
      ? wallet.debit({ ...movement, reversal: tx.requiresReference() })
      : wallet.credit(movement);

  await repos.wallets.save(wallet);
  await repos.ledger.insert(entry);
  tx.markProcessed(reference?.id, ctx.now);
  tx.recordObservedBalance(wallet.balance);
  await repos.transactions.save(tx);

  events.push(WagerTransactionProcessed.from(tx, eventContext(ctx)));
  events.push(WalletBalanceChanged.from(wallet, entry, eventContext(ctx)));
  return events;
}

/** Marca `tx` como REJECTED, registra o saldo (inalterado), salva e enfileira o evento. */
export async function rejectTransaction(
  repos: TransactionalRepositories,
  wallet: Wallet,
  tx: WagerTransaction,
  code: FailureCode,
  ctx: ProcessingContext,
): Promise<void> {
  tx.reject(code);
  tx.recordObservedBalance(wallet.balance);
  await repos.transactions.save(tx);
  await repos.outbox.insert(
    OutboxMessage.enqueue(WagerTransactionRejected.from(tx, code, eventContext(ctx))),
  );
}
