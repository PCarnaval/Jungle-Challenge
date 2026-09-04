import { describe, expect, it } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { WalletBalanceChanged } from "../../src/domain/messaging/events";

const AT = new Date("2026-01-01T00:00:00.000Z");
const brl = (a: string) => Money.from({ amount: a, currency: "BRL" });

describe("InboxMessage", () => {
  it("starts unprocessed and marks processed once", () => {
    const m = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "consumer-a",
      payloadHash: "h",
      receivedAt: AT,
    });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(AT);
    expect(m.isProcessed()).toBe(true);
    const firstProcessedAt = m.processedAt;
    m.markProcessed(new Date(AT.getTime() + 1000));
    expect(m.processedAt).toEqual(firstProcessedAt); // define uma única vez
  });
});

describe("OutboxMessage", () => {
  const event = () =>
    WalletBalanceChanged.from(
      Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("100.00"), now: AT }),
      Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("100.00"), now: AT }).debit({
        transactionId: "t1",
        ledgerEntryId: "le1",
        amount: brl("30.00"),
        at: AT,
      }),
      { eventId: "evt-1", correlationId: "corr-1", occurredAt: AT },
    );

  it("enqueue reuses the event id and starts pending", () => {
    const m = OutboxMessage.enqueue(event());
    expect(m.id).toBe("evt-1");
    expect(m.isPending()).toBe(true);
    expect(m.isDue(AT)).toBe(true);
    expect(m.attempts).toBe(0);
  });

  it("scheduleRetry applies exponential backoff and defers dueness", () => {
    const m = OutboxMessage.enqueue(event());
    m.scheduleRetry(AT, 1000);
    expect(m.attempts).toBe(1);
    expect(m.isDue(AT)).toBe(false);
    expect(m.isDue(new Date(AT.getTime() + 1000))).toBe(true);

    m.scheduleRetry(AT, 1000);
    expect(m.attempts).toBe(2);
    expect(m.nextAttemptAt!.getTime() - AT.getTime()).toBe(2000);
  });

  it("markPublished is terminal and idempotent", () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(AT);
    expect(m.isPending()).toBe(false);
    const first = m.publishedAt;
    m.markPublished(new Date(AT.getTime() + 5000));
    expect(m.publishedAt).toEqual(first);
  });
});

describe("WalletBalanceChanged", () => {
  it("serializes a stable JSON envelope with MoneyProps, never Money", () => {
    const wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("100.00"), now: AT });
    const entry = wallet.debit({ transactionId: "t1", ledgerEntryId: "le1", amount: brl("30.00"), at: AT });
    const evt = WalletBalanceChanged.from(wallet, entry, {
      eventId: "evt-1",
      correlationId: "corr-1",
      causationId: "cause-1",
      occurredAt: AT,
    });

    const json = evt.toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(json.data.balanceAfter).toEqual({ amount: "70.00", currency: "BRL" });
    expect(json.data.walletVersion).toBe(2);
    expect(typeof json.data.money.amount).toBe("string");
  });
});
