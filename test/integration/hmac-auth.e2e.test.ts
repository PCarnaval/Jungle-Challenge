import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/core";

import { AppModule } from "../../src/app.module";
import { DomainExceptionFilter } from "../../src/infrastructure/http/filters/domain-exception.filter";
import { computeSignature } from "../../src/infrastructure/auth/hmac";
import { getTestStack } from "../support/containers";

const SECRET = "provider-a-shared-secret-1234567890";
const uid = (): string => crypto.randomUUID();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (res: Response): Promise<any> => res.json() as Promise<any>;

let app: INestApplication;
let base: string;

interface SignOpts {
  providerId?: string;
  secret?: string;
  timestamp?: string;
  omitHeaders?: boolean;
  tamperBody?: string;
  idempotencyKey?: string;
}

const signed = (
  method: string,
  path: string,
  body?: unknown,
  opts: SignOpts = {},
): Promise<Response> => {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const providerId = opts.providerId ?? "provider-a";
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  if (!opts.omitHeaders) {
    headers["x-provider-id"] = providerId;
    headers["x-timestamp"] = timestamp;
    headers["x-signature"] = computeSignature(opts.secret ?? SECRET, {
      method,
      path,
      providerId,
      timestamp,
      rawBody: opts.tamperBody ?? raw,
    });
  }
  return fetch(base + path, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : raw,
  });
};

beforeAll(async () => {
  await getTestStack();
  process.env.WORKER = "api";
  process.env.AUTH_MODE = "hmac";
  process.env.PROVIDER_SECRETS = JSON.stringify({ "provider-a": SECRET, "provider-b": "other" });

  app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1").replace("::1", "127.0.0.1");

  await app
    .get(MikroORM)
    .em.getConnection()
    .execute(
      "truncate wallet, wager_transaction, wallet_ledger_entry, inbox_message, outbox_message cascade",
    );
}, 180_000);

afterAll(async () => {
  await app?.close();
  delete process.env.AUTH_MODE;
  delete process.env.PROVIDER_SECRETS;
});

async function makeWallet(): Promise<string> {
  const res = await signed("POST", "/wallets", {
    playerId: uid(),
    initialBalance: { amount: "100.00", currency: "BRL" },
  });
  expect(res.status).toBe(201);
  return (await j(res)).id;
}

const betBody = (walletId: string, over: Record<string, unknown> = {}) => ({
  providerId: "provider-a",
  externalTransactionId: uid(),
  playerId: uid(),
  walletId,
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "10.00", currency: "BRL" },
  ...over,
});

describe("HMAC auth (AUTH_MODE=hmac)", () => {
  it("health and metrics stay open without a signature", async () => {
    expect((await fetch(base + "/health/live")).status).toBe(200);
    const metrics = await fetch(base + "/metrics");
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("wager_auth_failures_total");
  });

  it("a correctly signed request is accepted", async () => {
    const walletId = await makeWallet();
    const res = await signed(
      "POST",
      "/wagering/transactions",
      betBody(walletId, { money: { amount: "30.00", currency: "BRL" } }),
      { idempotencyKey: `provider-a:${uid()}` },
    );
    expect(res.status).toBe(201);
    expect((await j(res)).status).toBe("PROCESSED");
  });

  it("a signed GET is accepted", async () => {
    const walletId = await makeWallet();
    const res = await signed("GET", `/wallets/${walletId}`);
    expect(res.status).toBe(200);
    expect((await j(res)).balance).toEqual({ amount: "100.00", currency: "BRL" });
  });

  it("missing auth headers → 401 UNAUTHENTICATED", async () => {
    const res = await signed("POST", "/wallets", { playerId: uid(), initialBalance: { amount: "1.00", currency: "BRL" } }, { omitHeaders: true });
    expect(res.status).toBe(401);
    expect((await j(res)).failureCode).toBe("UNAUTHENTICATED");
  });

  it("wrong secret → 401", async () => {
    const walletId = await makeWallet();
    const res = await signed("POST", "/wagering/transactions", betBody(walletId), { secret: "not-the-secret" });
    expect(res.status).toBe(401);
  });

  it("tampered body → 401", async () => {
    const walletId = await makeWallet();
    const res = await signed("POST", "/wagering/transactions", betBody(walletId), {
      tamperBody: '{"kind":"WIN"}',
    });
    expect(res.status).toBe(401);
  });

  it("stale timestamp → 401", async () => {
    const walletId = await makeWallet();
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await signed("POST", "/wagering/transactions", betBody(walletId), { timestamp: stale });
    expect(res.status).toBe(401);
  });

  it("unknown provider → 401", async () => {
    const walletId = await makeWallet();
    const res = await signed("POST", "/wagering/transactions", betBody(walletId, { providerId: "provider-z" }), {
      providerId: "provider-z",
      secret: SECRET,
    });
    expect(res.status).toBe(401);
  });

  it("body.providerId different from the authenticated provider → 403 FORBIDDEN", async () => {
    const walletId = await makeWallet();
    // assinatura válida para provider-a, mas o corpo diz provider-b
    const res = await signed("POST", "/wagering/transactions", betBody(walletId, { providerId: "provider-b" }), {
      providerId: "provider-a",
      secret: SECRET,
    });
    expect(res.status).toBe(403);
    expect((await j(res)).failureCode).toBe("FORBIDDEN");
  });

  it("counts failures in wager_auth_failures_total", async () => {
    const before = await (await fetch(base + "/metrics")).text();
    await signed("POST", "/wallets", {}, { omitHeaders: true });
    const after = await (await fetch(base + "/metrics")).text();
    const val = (t: string) =>
      Number(t.match(/wager_auth_failures_total\{reason="missing_headers"\}\s+(\d+)/)?.[1] ?? 0);
    expect(val(after)).toBeGreaterThan(val(before));
  });
});
