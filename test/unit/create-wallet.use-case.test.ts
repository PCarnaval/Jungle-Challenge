import { beforeEach, describe, expect, it } from "bun:test";
import {
  CreateWallet,
  type CreateWalletCommand,
} from "../../src/application/use-cases/create-wallet/create-wallet.use-case";
import {
  ValidationError,
  WalletAlreadyExistsError,
} from "../../src/application/application-error";
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

describe("CreateWallet", () => {
  let uow: InMemoryUnitOfWork;
  let useCase: CreateWallet;

  beforeEach(() => {
    uow = new InMemoryUnitOfWork();
    useCase = new CreateWallet(uow, new FixedClock(), new SeqIdGenerator("id"));
  });

  const cmd = (over: Partial<CreateWalletCommand> = {}): CreateWalletCommand => ({
    playerId: "player-1",
    initialBalance: { amount: "1000.00", currency: "BRL" },
    ...over,
  });

  it("opens a wallet at the given balance with version 1", async () => {
    const res = await useCase.execute(cmd());
    expect(res).toMatchObject({
      playerId: "player-1",
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
    expect(res.id).toBeTruthy();
  });

  it("writes an OPENING transaction + one CREDIT ledger entry in the same unit of work", async () => {
    const res = await useCase.execute(cmd());

    const entries = ledgerEntriesOf(uow.db, res.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe(LedgerDirection.Credit);
    expect(entries[0]!.balanceBefore.toJSON().amount).toBe("0.00");
    expect(entries[0]!.balanceAfter.toJSON().amount).toBe("1000.00");

    const txs = transactionsOf(uow.db);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.kind).toBe(WagerTransactionKind.Opening);
    expect(txs[0]!.status).toBe(WagerTransactionStatus.Processed);

    // saldo == replay do ledger
    expect(replayLedgerBalance(uow.db, res.id).toJSON().amount).toBe("1000.00");
  });

  it("enqueues WagerTransactionProcessed + WalletBalanceChanged", async () => {
    const res = await useCase.execute(cmd());
    const types = outboxOf(uow.db)
      .map((m) => m.eventType)
      .sort();
    expect(types).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    // o aggregateId do evento de saldo é o id da wallet
    const balanceEvt = outboxOf(uow.db).find((m) => m.eventType === "WalletBalanceChanged");
    expect(balanceEvt!.aggregateId).toBe(res.id);
  });

  it("a zero opening balance creates no OPENING transaction and no ledger entry", async () => {
    const res = await useCase.execute(cmd({ initialBalance: { amount: "0.00", currency: "BRL" } }));
    expect(ledgerEntriesOf(uow.db, res.id)).toHaveLength(0);
    expect(transactionsOf(uow.db)).toHaveLength(0);
    expect(outboxOf(uow.db)).toHaveLength(0);
    expect(res.balance.amount).toBe("0.00");
  });

  it("rejects a duplicate wallet for the same player + currency as a conflict", async () => {
    await useCase.execute(cmd());
    await expect(useCase.execute(cmd())).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    // nada gravado parcialmente pela tentativa que falhou
    expect([...uow.db.wallets.values()]).toHaveLength(1);
  });

  it("allows the same player to have wallets in different currencies", async () => {
    await useCase.execute(cmd());
    const usd = await useCase.execute(
      cmd({ initialBalance: { amount: "10.00", currency: "USD" } }),
    );
    expect(usd.balance).toEqual({ amount: "10.00", currency: "USD" });
    expect([...uow.db.wallets.values()]).toHaveLength(2);
  });

  it("rejects a negative initial balance with a validation error", async () => {
    await expect(
      useCase.execute(cmd({ initialBalance: { amount: "-1.00", currency: "BRL" } })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a malformed amount with a validation error", async () => {
    await expect(
      useCase.execute(cmd({ initialBalance: { amount: "10.999", currency: "BRL" } })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
