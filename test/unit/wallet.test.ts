import { describe, expect, it } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";
import {
  InsufficientFundsError,
  NegativeOpeningBalanceError,
  NonPositiveMovementError,
  ReversalWouldOverdrawError,
  WalletCurrencyMismatchError,
} from "../../src/domain/wallet/wallet.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const AT = new Date("2026-01-01T00:00:00.000Z");

const openWallet = (amount = "0") =>
  Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(amount),
    now: AT,
  });

describe("Wallet.open", () => {
  it("opens at the given balance with version 1", () => {
    const w = openWallet("100.00");
    expect(w.balance.toJSON().amount).toBe("100.00");
    expect(w.version).toBe(1);
  });

  it("opened at zero has no opening ledger entry", () => {
    const w = openWallet("0");
    expect(
      w.openingLedgerEntry({
        transactionId: "opening-tx",
        ledgerEntryId: "le-0",
        at: AT,
      }),
    ).toBeUndefined();
  });

  it("opened with a positive balance yields one balanced CREDIT opening entry", () => {
    const w = openWallet("1000.00");
    const entry = w.openingLedgerEntry({
      transactionId: "opening-tx",
      ledgerEntryId: "le-0",
      at: AT,
    });
    expect(entry).toBeDefined();
    expect(entry!.direction).toBe(LedgerDirection.Credit);
    expect(entry!.balanceBefore.toJSON().amount).toBe("0.00");
    expect(entry!.balanceAfter.toJSON().amount).toBe("1000.00");
    expect(entry!.isBalanced()).toBe(true);
    // a abertura não incrementa a versão
    expect(w.version).toBe(1);
  });

  it("rejects a negative opening balance", () => {
    expect(() =>
      Wallet.open({
        id: "w",
        playerId: "p",
        initialBalance: brl("10.00").subtract(brl("20.00")),
      }),
    ).toThrow(NegativeOpeningBalanceError);
  });
});

describe("Wallet.debit", () => {
  it("applies a debit, bumps version, returns a balanced DEBIT entry", () => {
    const w = openWallet("100.00");
    const entry = w.debit({
      transactionId: "bet-1",
      ledgerEntryId: "le-1",
      amount: brl("80.00"),
      at: AT,
    });

    expect(w.balance.toJSON().amount).toBe("20.00");
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
    expect(entry.isBalanced()).toBe(true);
  });

  it("rejects a debit that would overdraw and leaves state untouched", () => {
    const w = openWallet("100.00");
    w.debit({ transactionId: "bet-1", ledgerEntryId: "le-1", amount: brl("80.00"), at: AT });

    expect(() =>
      w.debit({ transactionId: "bet-2", ledgerEntryId: "le-2", amount: brl("80.00"), at: AT }),
    ).toThrow(InsufficientFundsError);

    // inalterado após o débito que falhou
    expect(w.balance.toJSON().amount).toBe("20.00");
    expect(w.version).toBe(2);
  });

  it("a debit that empties the wallet exactly is allowed", () => {
    const w = openWallet("50.00");
    w.debit({ transactionId: "bet", ledgerEntryId: "le", amount: brl("50.00"), at: AT });
    expect(w.balance.isZero()).toBe(true);
  });

  it("a reversal overdraft throws ReversalWouldOverdrawError (distinct code)", () => {
    const w = openWallet("30.00");
    expect(() =>
      w.debit({
        transactionId: "rollback-1",
        ledgerEntryId: "le-r",
        amount: brl("50.00"),
        at: AT,
        reversal: true,
      }),
    ).toThrow(ReversalWouldOverdrawError);
  });

  it("rejects a non-positive movement amount", () => {
    const w = openWallet("30.00");
    expect(() =>
      w.debit({ transactionId: "t", ledgerEntryId: "le", amount: brl("0.00"), at: AT }),
    ).toThrow(NonPositiveMovementError);
  });

  it("rejects an operation in a different currency", () => {
    const w = openWallet("30.00");
    expect(() =>
      w.debit({
        transactionId: "t",
        ledgerEntryId: "le",
        amount: Money.from({ amount: "10.00", currency: "USD" }),
        at: AT,
      }),
    ).toThrow(WalletCurrencyMismatchError);
  });
});

describe("Wallet.credit", () => {
  it("applies a credit, bumps version, returns a balanced CREDIT entry", () => {
    const w = openWallet("20.00");
    const entry = w.credit({
      transactionId: "win-1",
      ledgerEntryId: "le-3",
      amount: brl("120.00"),
      at: AT,
    });

    expect(w.balance.toJSON().amount).toBe("140.00");
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });
});

describe("Wallet — ledger reconstructs the balance", () => {
  it("balance equals the running sum of ledger entries", () => {
    const w = openWallet("100.00");
    const entries = [
      w.openingLedgerEntry({ transactionId: "opening", ledgerEntryId: "le-0", at: AT })!,
      w.debit({ transactionId: "bet-1", ledgerEntryId: "le-1", amount: brl("30.00"), at: AT }),
      w.credit({ transactionId: "win-1", ledgerEntryId: "le-2", amount: brl("45.00"), at: AT }),
      w.debit({ transactionId: "bet-2", ledgerEntryId: "le-3", amount: brl("15.00"), at: AT }),
    ];

    let replayed = Money.zero("BRL");
    for (const e of entries) replayed = replayed.add(e.signedAmount());

    expect(replayed.equals(w.balance)).toBe(true);
    expect(w.balance.toJSON().amount).toBe("100.00");
  });
});
