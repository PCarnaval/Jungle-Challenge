import { beforeEach, describe, expect, it } from "bun:test";
import { CreateWallet } from "../../src/application/use-cases/create-wallet/create-wallet.use-case";
import { ProcessWagerTransaction } from "../../src/application/use-cases/process-wager-transaction/process-wager-transaction.use-case";
import {
  ReprocessPendingReferences,
  type PendingReferenceConfig,
} from "../../src/application/use-cases/reprocess-pending-references/reprocess-pending-references.use-case";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wagering/wager-transaction";
import {
  FixedClock,
  InMemoryUnitOfWork,
  SeqIdGenerator,
  outboxOf,
  replayLedgerBalance,
  transactionsOf,
} from "../support/in-memory";

const CONFIG: PendingReferenceConfig = {
  batchSize: 50,
  baseBackoffMs: 1000,
  maxAttempts: 3,
  ttlMs: 60_000,
};

describe("ReprocessPendingReferences", () => {
  let uow: InMemoryUnitOfWork;
  let clock: FixedClock;
  let createWallet: CreateWallet;
  let process: ProcessWagerTransaction;
  let reprocess: ReprocessPendingReferences;

  beforeEach(() => {
    uow = new InMemoryUnitOfWork();
    clock = new FixedClock();
    createWallet = new CreateWallet(uow, clock, new SeqIdGenerator("w"));
    process = new ProcessWagerTransaction(uow, clock, new SeqIdGenerator("tx"));
    reprocess = new ReprocessPendingReferences(uow, clock, new SeqIdGenerator("rp"), CONFIG);
  });

  const seedWallet = async (amount = "100.00"): Promise<string> => {
    const r = await createWallet.execute({
      playerId: `player-${Math.random()}`,
      initialBalance: { amount, currency: "BRL" },
    });
    return r.id;
  };

  interface OpArgs {
    externalTransactionId: string;
    amount: string;
    kind?: WagerTransactionKind;
    reference?: string;
  }
  const op = (walletId: string, a: OpArgs) =>
    process.execute({
      idempotencyKey: `provider-a:${a.externalTransactionId}`,
      providerId: "provider-a",
      externalTransactionId: a.externalTransactionId,
      playerId: "player-x",
      walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: a.kind ?? WagerTransactionKind.Bet,
      money: { amount: a.amount, currency: "BRL" },
      referenceExternalTransactionId: a.reference,
    });

  const refundTx = () =>
    transactionsOf(uow.db).find((t) => t.kind === WagerTransactionKind.Refund)!;

  it("does nothing when there is nothing due", async () => {
    expect(await reprocess.execute()).toEqual({
      scanned: 0,
      processed: 0,
      rejected: 0,
      retried: 0,
      skipped: 0,
    });
  });

  it("resolves a REFUND that arrived before its BET (out-of-order delivery)", async () => {
    const walletId = await seedWallet("100.00");

    // REFUND primeiro — a BET ainda não existe
    const deferred = await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "30.00",
      kind: WagerTransactionKind.Refund,
      reference: "bet-1",
    });
    expect(deferred.status).toBe(WagerTransactionStatus.PendingReference);

    // varre enquanto ainda ausente → retentado, backoff agendado
    let summary = await reprocess.execute();
    expect(summary).toMatchObject({ scanned: 1, retried: 1 });
    expect(refundTx().referenceAttempts).toBe(1);

    // agora a BET chega
    clock.advance(5000);
    await op(walletId, { externalTransactionId: "bet-1", amount: "30.00" });
    expect(uow.db.wallets.get(walletId)!.balance.amount).toBe("70.00");

    // varre de novo → o REFUND se resolve
    summary = await reprocess.execute();
    expect(summary).toMatchObject({ scanned: 1, processed: 1 });

    expect(refundTx().status).toBe(WagerTransactionStatus.Processed);
    expect(uow.db.wallets.get(walletId)!.balance.amount).toBe("100.00");
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("100.00");
  });

  it("gives up after the attempt cap → REJECTED REFERENCE_NOT_FOUND + event", async () => {
    const walletId = await seedWallet("100.00");
    await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "30.00",
      kind: WagerTransactionKind.Refund,
      reference: "never-arrives",
    });

    // avança o suficiente para vencer o backoff a cada varredura, mas fica abaixo do TTL
    for (let i = 0; i < CONFIG.maxAttempts - 1; i++) {
      clock.advance(5_000);
      expect(await reprocess.execute()).toMatchObject({ retried: 1 });
    }
    clock.advance(5_000);
    expect(await reprocess.execute()).toMatchObject({ rejected: 1 });

    const tx = refundTx();
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(
      outboxOf(uow.db).some(
        (m) => m.eventType === "WagerTransactionRejected" && m.aggregateId === tx.id,
      ),
    ).toBe(true);

    // não é mais capturado
    expect(await reprocess.execute()).toMatchObject({ scanned: 0 });
  });

  it("gives up when the TTL is exceeded even below the attempt cap", async () => {
    const walletId = await seedWallet("100.00");
    await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "30.00",
      kind: WagerTransactionKind.Refund,
      reference: "never-arrives",
    });

    clock.advance(CONFIG.ttlMs + 1000);
    const summary = await reprocess.execute();
    expect(summary).toMatchObject({ rejected: 1 });
    expect(refundTx().failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it("rejects on the sweep when the reference finally arrives but is the wrong kind", async () => {
    const walletId = await seedWallet("100.00");
    await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "20.00",
      kind: WagerTransactionKind.Refund,
      reference: "win-1",
    });

    clock.advance(5000);
    await op(walletId, { externalTransactionId: "win-1", amount: "20.00", kind: WagerTransactionKind.Win });

    const summary = await reprocess.execute();
    expect(summary).toMatchObject({ rejected: 1 });
    expect(refundTx().failureCode).toBe(FailureCode.ReferenceKindMismatch);
  });

  it("two out-of-order REFUNDs for the same BET: one resolves, the other is ALREADY_REVERSED", async () => {
    const walletId = await seedWallet("100.00");

    await op(walletId, {
      externalTransactionId: "refund-A",
      amount: "30.00",
      kind: WagerTransactionKind.Refund,
      reference: "bet-1",
    });
    await op(walletId, {
      externalTransactionId: "refund-B",
      amount: "30.00",
      kind: WagerTransactionKind.Refund,
      reference: "bet-1",
    });

    clock.advance(5000);
    await op(walletId, { externalTransactionId: "bet-1", amount: "30.00" }); // saldo 70

    const summary = await reprocess.execute();
    expect(summary).toMatchObject({ scanned: 2, processed: 1, rejected: 1 });

    const refunds = transactionsOf(uow.db).filter((t) => t.kind === WagerTransactionKind.Refund);
    const statuses = refunds.map((t) => t.status).sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    expect(refunds.find((t) => t.status === WagerTransactionStatus.Rejected)!.failureCode).toBe(
      FailureCode.AlreadyReversed,
    );

    // exatamente um crédito de refund aplicado → de volta a 100.00
    expect(uow.db.wallets.get(walletId)!.balance.amount).toBe("100.00");
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("100.00");
  });
});
