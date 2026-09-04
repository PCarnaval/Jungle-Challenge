import { beforeEach, describe, expect, it } from "bun:test";
import { CreateWallet } from "../../src/application/use-cases/create-wallet/create-wallet.use-case";
import { ProcessWagerTransaction } from "../../src/application/use-cases/process-wager-transaction/process-wager-transaction.use-case";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wagering/wager-transaction";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";
import {
  FixedClock,
  InMemoryUnitOfWork,
  SeqIdGenerator,
  ledgerEntriesOf,
  outboxOf,
  replayLedgerBalance,
  transactionsOf,
} from "../support/in-memory";

describe("ProcessWagerTransaction — REFUND / ROLLBACK", () => {
  let uow: InMemoryUnitOfWork;
  let clock: FixedClock;
  let createWallet: CreateWallet;
  let process: ProcessWagerTransaction;
  let players = 0;

  beforeEach(() => {
    uow = new InMemoryUnitOfWork();
    clock = new FixedClock();
    createWallet = new CreateWallet(uow, clock, new SeqIdGenerator("w"));
    process = new ProcessWagerTransaction(uow, clock, new SeqIdGenerator("tx"));
    players = 0;
  });

  const seedWallet = async (amount = "100.00"): Promise<string> => {
    players += 1;
    const r = await createWallet.execute({
      playerId: `player-${players}`,
      initialBalance: { amount, currency: "BRL" },
    });
    return r.id;
  };

  interface OpArgs {
    externalTransactionId: string;
    amount: string;
    kind?: WagerTransactionKind;
    roundId?: string;
    reference?: string;
  }

  const op = (walletId: string, a: OpArgs) =>
    process.execute({
      idempotencyKey: `provider-a:${a.externalTransactionId}`,
      providerId: "provider-a",
      externalTransactionId: a.externalTransactionId,
      playerId: "player-x",
      walletId,
      roundId: a.roundId ?? "round-1",
      gameId: "game-1",
      kind: a.kind ?? WagerTransactionKind.Bet,
      money: { amount: a.amount, currency: "BRL" },
      referenceExternalTransactionId: a.reference,
    });

  const creditCount = (walletId: string) =>
    ledgerEntriesOf(uow.db, walletId).filter((e) => e.direction === LedgerDirection.Credit).length;

  it("REFUND of a PROCESSED BET credits the wallet back, one CREDIT ledger entry", async () => {
    const walletId = await seedWallet("100.00");
    await op(walletId, { externalTransactionId: "bet-1", amount: "30.00" });

    const res = await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "30.00",
      kind: WagerTransactionKind.Refund,
      reference: "bet-1",
    });

    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balance).toEqual({ amount: "100.00", currency: "BRL" });
    // CREDIT de abertura + CREDIT do refund
    expect(creditCount(walletId)).toBe(2);
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("100.00");
  });

  it("ROLLBACK of a BET is the inverse of a debit (a credit)", async () => {
    const walletId = await seedWallet("100.00");
    await op(walletId, { externalTransactionId: "bet-1", amount: "40.00" });

    const res = await op(walletId, {
      externalTransactionId: "rb-1",
      amount: "40.00",
      kind: WagerTransactionKind.Rollback,
      reference: "bet-1",
    });

    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balance).toEqual({ amount: "100.00", currency: "BRL" });
  });

  it("ROLLBACK of a WIN is the inverse of a credit (a debit)", async () => {
    const walletId = await seedWallet("10.00");
    await op(walletId, { externalTransactionId: "win-1", amount: "100.00", kind: WagerTransactionKind.Win });
    expect(uow.db.wallets.get(walletId)!.balance.amount).toBe("110.00");

    const res = await op(walletId, {
      externalTransactionId: "rb-win",
      amount: "100.00",
      kind: WagerTransactionKind.Rollback,
      reference: "win-1",
    });
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balance).toEqual({ amount: "10.00", currency: "BRL" });
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("10.00");
  });

  it("ROLLBACK that would overdraw is rejected with REVERSAL_WOULD_OVERDRAW (distinct code)", async () => {
    const walletId = await seedWallet("10.00");
    await op(walletId, { externalTransactionId: "win-1", amount: "100.00", kind: WagerTransactionKind.Win });
    await op(walletId, { externalTransactionId: "bet-big", amount: "105.00" }); // saldo agora 5.00

    const res = await op(walletId, {
      externalTransactionId: "rb-win",
      amount: "100.00",
      kind: WagerTransactionKind.Rollback,
      reference: "win-1",
    });
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(res.balance).toEqual({ amount: "5.00", currency: "BRL" }); // inalterado
  });

  it("REFUND referencing a non-BET is REJECTED with REFERENCE_KIND_MISMATCH", async () => {
    const walletId = await seedWallet("100.00");
    await op(walletId, { externalTransactionId: "win-1", amount: "20.00", kind: WagerTransactionKind.Win });

    const res = await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "20.00",
      kind: WagerTransactionKind.Refund,
      reference: "win-1",
    });
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.ReferenceKindMismatch);
  });

  it("REFUND with an amount different from the reference is REJECTED with AMOUNT_MISMATCH", async () => {
    const walletId = await seedWallet("100.00");
    await op(walletId, { externalTransactionId: "bet-1", amount: "30.00" });

    const res = await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "25.00",
      kind: WagerTransactionKind.Refund,
      reference: "bet-1",
    });
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.AmountMismatch);
  });

  it("REFUND with a different round is REJECTED with REFERENCE_ATTRIBUTES_MISMATCH", async () => {
    const walletId = await seedWallet("100.00");
    await op(walletId, { externalTransactionId: "bet-1", amount: "30.00", roundId: "round-1" });

    const res = await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "30.00",
      kind: WagerTransactionKind.Refund,
      reference: "bet-1",
      roundId: "round-2",
    });
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.ReferenceAttributesMismatch);
  });

  it("a reference can be reversed only once per operation type (ALREADY_REVERSED)", async () => {
    const walletId = await seedWallet("100.00");
    await op(walletId, { externalTransactionId: "bet-1", amount: "30.00" });

    const first = await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "30.00",
      kind: WagerTransactionKind.Refund,
      reference: "bet-1",
    });
    const second = await op(walletId, {
      externalTransactionId: "refund-2",
      amount: "30.00",
      kind: WagerTransactionKind.Refund,
      reference: "bet-1",
    });

    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("100.00");
  });

  it("defers to PENDING_REFERENCE when the reference exists but is not PROCESSED", async () => {
    const walletId = await seedWallet("10.00");
    // esta BET é rejeitada (fundos insuficientes) — ela existe mas não está PROCESSED
    await op(walletId, { externalTransactionId: "bet-1", amount: "50.00" });

    const res = await op(walletId, {
      externalTransactionId: "refund-1",
      amount: "50.00",
      kind: WagerTransactionKind.Refund,
      reference: "bet-1",
    });
    expect(res.status).toBe(WagerTransactionStatus.PendingReference);

    const pendingRefEvents = outboxOf(uow.db)
      .map((m) => m.eventType)
      .filter((t) => t === "WagerTransactionPendingReference");
    expect(pendingRefEvents).toHaveLength(1);

    const refundTx = transactionsOf(uow.db).find((t) => t.kind === WagerTransactionKind.Refund);
    expect(refundTx!.status).toBe(WagerTransactionStatus.PendingReference);
  });
});
