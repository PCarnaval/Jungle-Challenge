import { describe, expect, it } from "bun:test";
import { Money } from "../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
} from "../../src/domain/money/money.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from — valid input", () => {
  it("round-trips a canonical 2-decimal string", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  it("normalizes an integer string to 2-decimal scale", () => {
    expect(brl("25").toJSON().amount).toBe("25.00");
  });

  it("normalizes a 1-decimal string to 2-decimal scale", () => {
    expect(brl("25.5").toJSON().amount).toBe("25.50");
  });

  it("accepts zero", () => {
    expect(Money.zero("BRL").toJSON().amount).toBe("0.00");
    expect(brl("0").isZero()).toBe(true);
  });

  it("keeps large integer parts exact", () => {
    expect(brl("1000000000000.01").toJSON().amount).toBe("1000000000000.01");
  });
});

describe("Money.from — invalid input is rejected", () => {
  const rejected: Array<[string, unknown]> = [
    ["empty string", ""],
    ["not a string", 25 as unknown],
    ["null props", null as unknown],
    ["more than 2 decimals", "25.555"],
    ["scientific notation", "1e3"],
    ["negative", "-5.00"],
    ["leading whitespace", " 1.00"],
    ["trailing whitespace", "1.00 "],
    ["NaN literal", "NaN"],
    ["Infinity literal", "Infinity"],
    ["comma decimal", "25,00"],
    ["bare dot", "1."],
    ["dot only", "."],
    ["plus sign", "+1.00"],
    ["hex", "0x10"],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() =>
        Money.from({ amount: value as string, currency: "BRL" }),
      ).toThrow(InvalidMoneyAmountError);
    });
  }
});

describe("Money.from — currency validation", () => {
  for (const bad of ["brl", "BR", "REAIS", "B2L", "", "  "]) {
    it(`rejects currency ${JSON.stringify(bad)}`, () => {
      expect(() => Money.from({ amount: "1.00", currency: bad })).toThrow(
        InvalidCurrencyError,
      );
    });
  }

  it("rejects a non-string currency", () => {
    expect(() =>
      Money.from({ amount: "1.00", currency: 123 as unknown as string }),
    ).toThrow(InvalidCurrencyError);
  });
});

describe("Money — arithmetic is immutable", () => {
  it("add / subtract return new instances and leave operands untouched", () => {
    const a = brl("10.00");
    const b = brl("2.50");

    expect(a.add(b).toJSON().amount).toBe("12.50");
    expect(a.subtract(b).toJSON().amount).toBe("7.50");
    // operandos inalterados
    expect(a.toJSON().amount).toBe("10.00");
    expect(b.toJSON().amount).toBe("2.50");
  });

  it("subtract can produce a negative value via trusted arithmetic", () => {
    const result = brl("2.00").subtract(brl("5.00"));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe("-3.00");
  });

  it("negate flips the sign", () => {
    expect(brl("5.00").negate().toJSON().amount).toBe("-5.00");
    expect(brl("5.00").negate().negate().toJSON().amount).toBe("5.00");
  });

  it("does not accumulate binary floating-point error", () => {
    let acc = Money.zero("BRL");
    for (let i = 0; i < 10; i++) acc = acc.add(brl("0.10"));
    expect(acc.toJSON().amount).toBe("1.00");
  });
});

describe("Money — cross-currency operations throw", () => {
  it("add across currencies throws CurrencyMismatchError", () => {
    const real = Money.from({ amount: "1.00", currency: "BRL" });
    const dollar = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => real.add(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.subtract(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.isLessThan(dollar)).toThrow(CurrencyMismatchError);
  });

  it("equals across currencies is false, not an error", () => {
    const real = Money.from({ amount: "1.00", currency: "BRL" });
    const dollar = Money.from({ amount: "1.00", currency: "USD" });
    expect(real.equals(dollar)).toBe(false);
  });
});

describe("Money — predicates", () => {
  it("isLessThan / isGreaterThanOrEqualTo / equals", () => {
    expect(brl("1.00").isLessThan(brl("2.00"))).toBe(true);
    expect(brl("2.00").isGreaterThanOrEqualTo(brl("2.00"))).toBe(true);
    expect(brl("2.00").equals(brl("2.00"))).toBe(true);
    expect(brl("2.00").equals(brl("2.01"))).toBe(false);
  });

  it("isZero / isPositive / isNegative", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
  });
});
