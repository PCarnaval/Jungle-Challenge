import { beforeEach, describe, expect, it } from "bun:test";
import { CreateWallet } from "../../src/application/use-cases/create-wallet/create-wallet.use-case";
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from "../../src/application/use-cases/process-wager-transaction/process-wager-transaction.use-case";
import {
  IdempotencyConflictError,
  ValidationError,
  WalletNotFoundError,
} from "../../src/application/application-error";
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

describe("ProcessWagerTransaction", () => {
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

  const seedWallet = async (amount = "100.00", currency = "BRL"): Promise<string> => {
    players += 1;
    const r = await createWallet.execute({
      playerId: `player-${players}`,
      initialBalance: { amount, currency },
    });
    return r.id;
  };

  const bet = (
    walletId: string,
    over: Partial<ProcessWagerTransactionCommand> = {},
  ): ProcessWagerTransactionCommand => ({
    idempotencyKey: over.idempotencyKey ?? `provider-a:${over.externalTransactionId ?? "ext-1"}`,
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    playerId: "player-1",
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    ...over,
  });

  const debitCount = (walletId: string) =>
    ledgerEntriesOf(uow.db, walletId).filter((e) => e.direction === LedgerDirection.Debit).length;

  it("applies a BET: PROCESSED, balance debited, one DEBIT ledger entry, two events", async () => {
    const walletId = await seedWallet("100.00");
    const outboxBaseline = outboxOf(uow.db).length;

    const res = await process.execute(bet(walletId, { money: { amount: "30.00", currency: "BRL" } }));

    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.idempotentReplay).toBe(false);
    expect(res.balance).toEqual({ amount: "70.00", currency: "BRL" });

    expect(debitCount(walletId)).toBe(1);
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("70.00");

    const emitted = outboxOf(uow.db)
      .slice(outboxBaseline)
      .map((m) => m.eventType)
      .sort();
    expect(emitted).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  it("applies a WIN as a credit", async () => {
    const walletId = await seedWallet("50.00");
    const res = await process.execute(
      bet(walletId, { kind: WagerTransactionKind.Win, money: { amount: "120.00", currency: "BRL" } }),
    );
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balance).toEqual({ amount: "170.00", currency: "BRL" });
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("170.00");
  });

  it("applies a LOSS with no ledger entry and only a Processed event", async () => {
    const walletId = await seedWallet("100.00");
    const outboxBaseline = outboxOf(uow.db).length; // ignora os eventos de abertura da wallet

    const res = await process.execute(
      bet(walletId, { kind: WagerTransactionKind.Loss, money: { amount: "40.00", currency: "BRL" } }),
    );
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balance).toEqual({ amount: "100.00", currency: "BRL" });
    // apenas o lançamento de abertura — LOSS não adiciona nenhum
    expect(ledgerEntriesOf(uow.db, walletId)).toHaveLength(1);

    const emitted = outboxOf(uow.db)
      .slice(outboxBaseline)
      .map((m) => m.eventType);
    expect(emitted).toEqual(["WagerTransactionProcessed"]);
  });

  it("rejects a BET with insufficient funds: REJECTED, no ledger entry, Rejected event", async () => {
    const walletId = await seedWallet("20.00");
    const res = await process.execute(bet(walletId, { money: { amount: "80.00", currency: "BRL" } }));

    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(res.balance).toEqual({ amount: "20.00", currency: "BRL" }); // inalterado
    expect(debitCount(walletId)).toBe(0);

    const tx = transactionsOf(uow.db).find((t) => t.kind === WagerTransactionKind.Bet);
    expect(tx!.status).toBe(WagerTransactionStatus.Rejected);
    expect(outboxOf(uow.db).map((m) => m.eventType)).toContain("WagerTransactionRejected");
  });

  it("mandatory §8 scenario: 100.00, two 80.00 bets → one PROCESSED, one REJECTED, final 20.00, one debit", async () => {
    const walletId = await seedWallet("100.00");

    const a = await process.execute(
      bet(walletId, { externalTransactionId: "bet-A", money: { amount: "80.00", currency: "BRL" } }),
    );
    const b = await process.execute(
      bet(walletId, { externalTransactionId: "bet-B", money: { amount: "80.00", currency: "BRL" } }),
    );

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    expect(b.failureCode).toBe(FailureCode.InsufficientFunds);

    expect(debitCount(walletId)).toBe(1);
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("20.00");
  });

  it("idempotent replay: same key + same payload returns the original result, no second debit", async () => {
    const walletId = await seedWallet("100.00");
    const command = bet(walletId, { money: { amount: "80.00", currency: "BRL" } });

    const first = await process.execute(command);
    const replay = await process.execute(command);

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.balance).toEqual({ amount: "20.00", currency: "BRL" }); // saldo observado no momento do processamento

    expect(debitCount(walletId)).toBe(1);
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("20.00");
  });

  it("idempotency conflict: same key + different payload is a conflict, not a replay", async () => {
    const walletId = await seedWallet("100.00");
    await process.execute(bet(walletId, { money: { amount: "10.00", currency: "BRL" } }));

    await expect(
      process.execute(bet(walletId, { money: { amount: "20.00", currency: "BRL" } })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(debitCount(walletId)).toBe(1);
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("90.00");
  });

  it("rejects a currency mismatch as a persisted REJECTED transaction", async () => {
    const walletId = await seedWallet("100.00", "BRL");
    const res = await process.execute(
      bet(walletId, { money: { amount: "10.00", currency: "USD" } }),
    );
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.WalletCurrencyMismatch);
    expect(debitCount(walletId)).toBe(0);
    expect(outboxOf(uow.db).map((m) => m.eventType)).toContain("WagerTransactionRejected");
  });

  it("throws WalletNotFoundError and persists nothing when the wallet is absent", async () => {
    await expect(process.execute(bet("missing-wallet"))).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(transactionsOf(uow.db)).toHaveLength(0);
  });

  it("rejects an OPENING kind submitted externally", async () => {
    const walletId = await seedWallet();
    await expect(
      process.execute(bet(walletId, { kind: WagerTransactionKind.Opening })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("defers a REFUND to PENDING_REFERENCE when the referenced BET is absent", async () => {
    const walletId = await seedWallet("100.00");
    const res = await process.execute(
      bet(walletId, {
        kind: WagerTransactionKind.Refund,
        externalTransactionId: "refund-1",
        referenceExternalTransactionId: "missing-bet",
        money: { amount: "25.00", currency: "BRL" },
      }),
    );
    expect(res.status).toBe(WagerTransactionStatus.PendingReference);
    expect(res.balance).toBeUndefined();
    expect(res.idempotentReplay).toBe(false);
    expect(debitCount(walletId)).toBe(0);
  });

  it("rejects REFUND/ROLLBACK submitted without a reference id (MISSING_REFERENCE)", async () => {
    const walletId = await seedWallet();
    await expect(
      process.execute(bet(walletId, { kind: WagerTransactionKind.Rollback })),
    ).rejects.toMatchObject({ failureCode: FailureCode.MissingReference });
  });

  it("rejects malformed money with a validation error", async () => {
    const walletId = await seedWallet();
    await expect(
      process.execute(bet(walletId, { money: { amount: "1.999", currency: "BRL" } })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps balance == ledger replay across a mixed sequence", async () => {
    const walletId = await seedWallet("200.00");
    await process.execute(bet(walletId, { externalTransactionId: "b1", money: { amount: "50.00", currency: "BRL" } }));
    await process.execute(
      bet(walletId, { externalTransactionId: "w1", kind: WagerTransactionKind.Win, money: { amount: "30.00", currency: "BRL" } }),
    );
    await process.execute(
      bet(walletId, { externalTransactionId: "l1", kind: WagerTransactionKind.Loss, money: { amount: "10.00", currency: "BRL" } }),
    );
    await process.execute(bet(walletId, { externalTransactionId: "b2", money: { amount: "500.00", currency: "BRL" } })); // rejeitada

    const wallet = uow.db.wallets.get(walletId)!;
    expect(wallet.balance.amount).toBe("180.00");
    expect(replayLedgerBalance(uow.db, walletId).toJSON().amount).toBe("180.00");
  });
});
