import { describe, expect, it } from "bun:test";
import { isConnectivityError } from "../../src/infrastructure/persistence/mikro-orm/mikro-unit-of-work";

describe("isConnectivityError", () => {
  it("reconhece um Error de driver com code de conexão", () => {
    expect(isConnectivityError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    }))).toBe(true);
  });

  it("reconhece um AggregateError cru do net (Postgres inacessível)", () => {
    const agg = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED ::1:5432"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
      ],
      "",
    );
    expect(isConnectivityError(agg)).toBe(true);
  });

  it("varre a cadeia de `cause`", () => {
    const outer = new Error("query failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(isConnectivityError(outer)).toBe(true);
  });

  it("reconhece pela mensagem quando não há `code`", () => {
    expect(isConnectivityError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("não classifica erros de negócio ou de validação como conexão", () => {
    expect(isConnectivityError(new Error("insufficient funds"))).toBe(false);
    expect(isConnectivityError(Object.assign(new Error("bad input"), { code: "23514" }))).toBe(false);
    expect(isConnectivityError(null)).toBe(false);
    expect(isConnectivityError(undefined)).toBe(false);
  });

  it("termina em cadeias de `cause` circulares", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isConnectivityError(a)).toBe(false);
  });
});
