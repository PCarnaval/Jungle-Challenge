import { describe, expect, it } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from "../../src/domain/wagering/wager-transaction";
import {
  InvalidTransactionStateError,
  NoLedgerDirectionError,
  NonPositiveTransactionAmountError,
  OpeningNotSubmittableError,
  ReferenceRequiredError,
  TransactionContextRequiredError,
} from "../../src/domain/wagering/wager-transaction.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const AT = new Date("2026-01-01T00:00:00.000Z");

const createProps = (
  over: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: "tx-1",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  idempotencyKey: "provider-a:ext-1",
  payloadHash: "hash-1",
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: brl("25.00"),
  createdAt: AT,
  ...over,
});

describe("WagerTransaction.create", () => {
  it("is born PENDING and not terminal", () => {
    const tx = WagerTransaction.create(createProps());
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
  });

  it("rejects OPENING submitted through create()", () => {
    expect(() => WagerTransaction.create(createProps({ kind: WagerTransactionKind.Opening }))).toThrow(
      OpeningNotSubmittableError,
    );
  });

  it("requires a reference for REFUND and ROLLBACK", () => {
    expect(() => WagerTransaction.create(createProps({ kind: WagerTransactionKind.Refund }))).toThrow(
      ReferenceRequiredError,
    );
    expect(() => WagerTransaction.create(createProps({ kind: WagerTransactionKind.Rollback }))).toThrow(
      ReferenceRequiredError,
    );
    expect(() =>
      WagerTransaction.create(
        createProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-bet" }),
      ),
    ).not.toThrow();
  });

  it("requires round and game context for provider kinds", () => {
    expect(() => WagerTransaction.create(createProps({ roundId: "" }))).toThrow(
      TransactionContextRequiredError,
    );
    expect(() => WagerTransaction.create(createProps({ gameId: "" }))).toThrow(
      TransactionContextRequiredError,
    );
  });

  it("rejects a non-positive amount", () => {
    expect(() => WagerTransaction.create(createProps({ money: brl("0.00") }))).toThrow(
      NonPositiveTransactionAmountError,
    );
  });
});

describe("WagerTransaction.opening", () => {
  it("builds an internal OPENING credit with no round/game", () => {
    const tx = WagerTransaction.opening({
      id: "op-1",
      walletId: "wallet-1",
      playerId: "player-1",
      money: brl("1000.00"),
      createdAt: AT,
    });
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.roundId).toBeNull();
    expect(tx.gameId).toBeNull();
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe("WagerTransaction — transitions", () => {
  it("PENDING -> PROCESSED sets processedAt and becomes terminal", () => {
    const tx = WagerTransaction.create(createProps());
    tx.markProcessed(undefined, AT);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(AT);
    expect(tx.isTerminal()).toBe(true);
  });

  it("transitioning a terminal transaction throws InvalidTransactionStateError", () => {
    const tx = WagerTransaction.create(createProps());
    tx.markProcessed(undefined, AT);
    expect(() => tx.markProcessed(undefined, AT)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
  });

  it("reject records the failure code and is terminal", () => {
    const tx = WagerTransaction.create(createProps());
    tx.reject(FailureCode.InsufficientFunds);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
  });

  it("PENDING -> PENDING_REFERENCE -> PROCESSED", () => {
    const tx = WagerTransaction.create(
      createProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-bet" }),
    );
    tx.markPendingReference(AT);
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed("ref-tx-id", AT);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe("ref-tx-id");
  });
});

describe("WagerTransaction — reference reprocessing bookkeeping", () => {
  it("scheduleReferenceRetry increments attempts with growing backoff", () => {
    const tx = WagerTransaction.create(
      createProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-bet" }),
    );
    tx.markPendingReference(AT);

    tx.scheduleReferenceRetry(AT, 1000);
    expect(tx.referenceAttempts).toBe(1);
    const first = tx.nextAttemptAt!.getTime() - AT.getTime();

    tx.scheduleReferenceRetry(AT, 1000);
    expect(tx.referenceAttempts).toBe(2);
    const second = tx.nextAttemptAt!.getTime() - AT.getTime();

    expect(second).toBeGreaterThan(first);
  });

  it("shouldGiveUpOnReference honours the attempt cap and the TTL", () => {
    const tx = WagerTransaction.create(
      createProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-bet" }),
    );
    tx.markPendingReference(AT);

    expect(tx.shouldGiveUpOnReference(AT, 3, 60_000)).toBe(false);
    tx.scheduleReferenceRetry(AT);
    tx.scheduleReferenceRetry(AT);
    tx.scheduleReferenceRetry(AT);
    expect(tx.shouldGiveUpOnReference(AT, 3, 60_000)).toBe(true);

    const fresh = WagerTransaction.create(
      createProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-bet" }),
    );
    fresh.markPendingReference(AT);
    const later = new Date(AT.getTime() + 61_000);
    expect(fresh.shouldGiveUpOnReference(later, 99, 60_000)).toBe(true);
  });
});

describe("WagerTransaction — domain queries", () => {
  it("affectsBalance is false only for LOSS", () => {
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]) {
      const props =
        kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
          ? createProps({ kind, referenceExternalTransactionId: "ext" })
          : createProps({ kind });
      expect(WagerTransaction.create(props).affectsBalance()).toBe(true);
    }
    expect(WagerTransaction.create(createProps({ kind: WagerTransactionKind.Loss })).affectsBalance()).toBe(
      false,
    );
  });

  it("requiresReference is true only for REFUND and ROLLBACK", () => {
    expect(WagerTransaction.create(createProps({ kind: WagerTransactionKind.Bet })).requiresReference()).toBe(
      false,
    );
    expect(
      WagerTransaction.create(
        createProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "e" }),
      ).requiresReference(),
    ).toBe(true);
  });

  it("ledgerDirectionFor resolves each kind", () => {
    const bet = WagerTransaction.create(createProps({ kind: WagerTransactionKind.Bet }));
    const win = WagerTransaction.create(createProps({ kind: WagerTransactionKind.Win }));
    const refund = WagerTransaction.create(
      createProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "e" }),
    );
    const rollback = WagerTransaction.create(
      createProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "e" }),
    );
    const loss = WagerTransaction.create(createProps({ kind: WagerTransactionKind.Loss }));

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit); // inverso de um débito
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit); // inverso de um crédito
    expect(() => rollback.ledgerDirectionFor()).toThrow(ReferenceRequiredError);
    expect(() => loss.ledgerDirectionFor()).toThrow(NoLedgerDirectionError);
  });

  it("matchesPayload compares the stored hash", () => {
    const tx = WagerTransaction.create(createProps({ payloadHash: "abc" }));
    expect(tx.matchesPayload("abc")).toBe(true);
    expect(tx.matchesPayload("xyz")).toBe(false);
  });
});

describe("WagerTransaction — rehydrate round-trips", () => {
  it("toState -> rehydrate preserves everything", () => {
    const tx = WagerTransaction.create(
      createProps({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-bet" }),
    );
    tx.markPendingReference(AT);
    tx.scheduleReferenceRetry(AT);

    const restored = WagerTransaction.rehydrate(tx.toState());
    expect(restored.toState()).toEqual(tx.toState());
  });
});
