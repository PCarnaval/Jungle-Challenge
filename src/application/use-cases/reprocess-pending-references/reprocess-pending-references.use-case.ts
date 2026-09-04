import { FailureCode } from "../../../domain/wagering/failure-code";
import { WagerTransactionRejected } from "../../../domain/messaging/events";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";

import type { Clock, IdGenerator } from "../../ports/system.ports";
import type { UnitOfWork } from "../../ports/unit-of-work.port";
import {
  applyAcceptedTransaction,
  eventContext,
  rejectTransaction,
  toFailureCode,
  validateReferenceMatch,
  type ProcessingContext,
} from "../wager-processing";

export interface PendingReferenceConfig {
  batchSize: number;
  baseBackoffMs: number;
  maxAttempts: number;
  ttlMs: number;
}

export interface ReprocessSummary {
  scanned: number;
  processed: number;
  rejected: number;
  retried: number;
  skipped: number;
}

type Outcome = "processed" | "rejected" | "retried" | "skipped";

/**
 * Leva as transações PENDING_REFERENCE a um estado terminal (README item 7.1).
 * Um worker agendado chama `execute()` num intervalo. Cada transação é
 * reprocessada sob o lock da sua própria wallet, com backoff exponencial e uma
 * política de desistência (limite de tentativas OU TTL) → REJECTED
 * `REFERENCE_NOT_FOUND`.
 */
export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly config: PendingReferenceConfig,
  ) {}

  async execute(): Promise<ReprocessSummary> {
    const now = this.clock.now();
    const due = await this.uow.run({ name: "pending-reference:list" }, (repos) =>
      repos.transactions.listDuePendingReference(this.config.batchSize, now),
    );

    const summary: ReprocessSummary = {
      scanned: due.length,
      processed: 0,
      rejected: 0,
      retried: 0,
      skipped: 0,
    };

    for (const stale of due) {
      const outcome = await this.reprocessOne(stale.id, stale.walletId);
      summary[outcome] += 1;
    }
    return summary;
  }

  private async reprocessOne(transactionId: string, walletId: string): Promise<Outcome> {
    const now = this.clock.now();

    return this.uow.run(
      { lockWallet: walletId, name: "pending-reference:reprocess" },
      async (repos): Promise<Outcome> => {
        const tx = await repos.transactions.findById(transactionId);
        if (!tx || !tx.isPendingReference()) {
          return "skipped"; // já resolvida por outro worker
        }

        const ctx: ProcessingContext = { now, correlationId: tx.id, ids: this.ids };
        const reference = await repos.transactions.findByProviderAndExternalId(
          tx.providerId,
          tx.referenceExternalTransactionId as string,
        );

        if (!reference || !reference.isProcessed()) {
          tx.scheduleReferenceRetry(now, this.config.baseBackoffMs);
          if (tx.shouldGiveUpOnReference(now, this.config.maxAttempts, this.config.ttlMs)) {
            tx.reject(FailureCode.ReferenceNotFound);
            await repos.transactions.save(tx);
            await repos.outbox.insert(
              OutboxMessage.enqueue(
                WagerTransactionRejected.from(tx, FailureCode.ReferenceNotFound, eventContext(ctx)),
              ),
            );
            return "rejected";
          }
          await repos.transactions.save(tx);
          return "retried";
        }

        const wallet = await repos.wallets.findById(tx.walletId);
        if (!wallet) {
          tx.fail(FailureCode.InternalError);
          await repos.transactions.save(tx);
          return "rejected";
        }

        const mismatch = validateReferenceMatch(tx, reference);
        if (mismatch) {
          await rejectTransaction(repos, wallet, tx, mismatch, ctx);
          return "rejected";
        }

        const existingReversal = await repos.transactions.findActiveReversalOf(
          reference.id,
          tx.kind,
        );
        if (existingReversal && existingReversal.id !== tx.id) {
          await rejectTransaction(repos, wallet, tx, FailureCode.AlreadyReversed, ctx);
          return "rejected";
        }

        try {
          const events = await applyAcceptedTransaction(repos, wallet, tx, reference, ctx);
          await repos.outbox.insertMany(events.map((e) => OutboxMessage.enqueue(e)));
          return "processed";
        } catch (err) {
          const code = toFailureCode(err);
          if (!code) throw err;
          await rejectTransaction(repos, wallet, tx, code, ctx);
          return "rejected";
        }
      },
    );
  }
}
