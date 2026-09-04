import { describe, expect, it } from "bun:test";
import { canonicalJson } from "../../src/application/canonical-json";
import { Money } from "../../src/domain/money/money";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction";
import { hashBusinessFields, toBusinessFields } from "../../src/application/wager-payload";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("is order-independent for the same content", () => {
    const a = canonicalJson({ x: "1", y: "2", z: null });
    const b = canonicalJson({ z: null, y: "2", x: "1" });
    expect(a).toBe(b);
  });

  it("preserves array order", () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it("drops undefined members", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("payload hashing", () => {
  const base = {
    providerId: "provider-a",
    externalTransactionId: "tx-123",
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-9",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
  };

  it("normalizes money before hashing (25 == 25.00)", () => {
    const h1 = hashBusinessFields(
      toBusinessFields(base, Money.from({ amount: "25", currency: "BRL" })),
    );
    const h2 = hashBusinessFields(
      toBusinessFields(base, Money.from({ amount: "25.00", currency: "BRL" })),
    );
    expect(h1).toBe(h2);
  });

  it("changes when a business field changes", () => {
    const h1 = hashBusinessFields(
      toBusinessFields(base, Money.from({ amount: "25.00", currency: "BRL" })),
    );
    const h2 = hashBusinessFields(
      toBusinessFields(base, Money.from({ amount: "25.01", currency: "BRL" })),
    );
    expect(h1).not.toBe(h2);
  });

  it("is a 64-char hex sha-256 digest", () => {
    const h = hashBusinessFields(
      toBusinessFields(base, Money.from({ amount: "1.00", currency: "BRL" })),
    );
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
