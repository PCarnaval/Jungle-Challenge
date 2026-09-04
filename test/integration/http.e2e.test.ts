import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/core";

import { AppModule } from "../../src/app.module";
import { DomainExceptionFilter } from "../../src/infrastructure/http/filters/domain-exception.filter";
import { getTestStack } from "../support/containers";

/**
 * Stack HTTP completa contra um Postgres + LocalStack reais iniciados pelo testcontainers.
 *   bun test test/integration
 */
let app: INestApplication;
let base: string;

const uid = (): string => crypto.randomUUID();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (res: Response): Promise<any> => res.json() as Promise<any>;

beforeAll(async () => {
  await getTestStack(); // sobe os containers (uma vez) + preenche process.env
  process.env.WORKER = "api"; // não inicia o consumidor SQS / relay nesta suíte
  process.env.AUTH_MODE = "none"; // esta suíte é anterior à auth; a cobertura de hmac está em hmac-auth.e2e
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1").replace("::1", "127.0.0.1");

  const orm = app.get(MikroORM);
  await orm.em
    .getConnection()
    .execute(
      "truncate wallet, wager_transaction, wallet_ledger_entry, inbox_message, outbox_message cascade",
    );
}, 180_000);

afterAll(async () => {
  await app?.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const get = (path: string): Promise<Response> => fetch(base + path);

async function makeWallet(amount = "100.00"): Promise<{ id: string }> {
  const res = await post("/wallets", {
    playerId: uid(),
    initialBalance: { amount, currency: "BRL" },
  });
  expect(res.status).toBe(201);
  return j(res);
}

const betBody = (walletId: string, over: Record<string, unknown> = {}) => ({
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  playerId: uid(), // player_id é uma coluna uuid
  walletId,
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
  ...over,
});

describe("HTTP API (e2e)", () => {
  it("health endpoints are open and report status", async () => {
    const live = await get("/health/live");
    expect(live.status).toBe(200);
    expect(await j(live)).toEqual({ status: "ok" });

    const ready = await get("/health/ready");
    expect(ready.status).toBe(200);
    expect((await j(ready)).checks.postgres).toBe("up");
  });

  it("POST /wallets creates a wallet; duplicate is 409", async () => {
    const playerId = uid();
    const first = await post("/wallets", {
      playerId,
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });
    expect(first.status).toBe(201);
    expect(await j(first)).toMatchObject({
      playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });

    const dup = await post("/wallets", {
      playerId,
      initialBalance: { amount: "1.00", currency: "BRL" },
    });
    expect(dup.status).toBe(409);
    expect((await j(dup)).failureCode).toBe("WALLET_ALREADY_EXISTS");
  });

  it("GET /wallets/:id returns the wallet; unknown id is 404", async () => {
    const { id } = await makeWallet("50.00");
    const ok = await get(`/wallets/${id}`);
    expect(ok.status).toBe(200);
    expect((await j(ok)).balance).toEqual({ amount: "50.00", currency: "BRL" });

    const missing = await get(`/wallets/${uid()}`);
    expect(missing.status).toBe(404);
  });

  it("POST /wagering/transactions requires the Idempotency-Key header", async () => {
    const { id } = await makeWallet();
    const res = await post("/wagering/transactions", betBody(id));
    expect(res.status).toBe(400);
    expect((await j(res)).failureCode).toBe("VALIDATION_ERROR");
  });

  it("BET → 201 PROCESSED; identical retry → 200 replay; same key + other payload → 409", async () => {
    const { id } = await makeWallet("100.00");
    const key = `provider-a:${uid()}`;
    const body = betBody(id, {
      externalTransactionId: "bet-1",
      money: { amount: "30.00", currency: "BRL" },
    });

    const first = await post("/wagering/transactions", body, { "idempotency-key": key });
    expect(first.status).toBe(201);
    const firstBody = await j(first);
    expect(firstBody).toMatchObject({ status: "PROCESSED", idempotentReplay: false });
    expect(firstBody.balance).toEqual({ amount: "70.00", currency: "BRL" });

    const replay = await post("/wagering/transactions", body, { "idempotency-key": key });
    expect(replay.status).toBe(200);
    expect(await j(replay)).toMatchObject({
      transactionId: firstBody.transactionId,
      status: "PROCESSED",
      idempotentReplay: true,
      balance: { amount: "70.00", currency: "BRL" },
    });

    const conflict = await post(
      "/wagering/transactions",
      { ...body, money: { amount: "31.00", currency: "BRL" } },
      { "idempotency-key": key },
    );
    expect(conflict.status).toBe(409);
    expect((await j(conflict)).failureCode).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("BET with insufficient funds → 422 with failureCode", async () => {
    const { id } = await makeWallet("20.00");
    const res = await post(
      "/wagering/transactions",
      betBody(id, { externalTransactionId: uid(), money: { amount: "80.00", currency: "BRL" } }),
      { "idempotency-key": `provider-a:${uid()}` },
    );
    expect(res.status).toBe(422);
    const body = await j(res);
    expect(body.status).toBe("REJECTED");
    expect(body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(body.balance).toEqual({ amount: "20.00", currency: "BRL" });
  });

  it("REFUND before its BET → 202 PENDING_REFERENCE", async () => {
    const { id } = await makeWallet("100.00");
    const res = await post(
      "/wagering/transactions",
      betBody(id, {
        externalTransactionId: uid(),
        kind: "REFUND",
        referenceExternalTransactionId: "missing-bet",
        money: { amount: "10.00", currency: "BRL" },
      }),
      { "idempotency-key": `provider-a:${uid()}` },
    );
    expect(res.status).toBe(202);
    expect((await j(res)).status).toBe("PENDING_REFERENCE");
  });

  it("transaction lookups: by internal id and by provider + external id", async () => {
    const { id } = await makeWallet("100.00");
    const ext = uid();
    const submit = await post(
      "/wagering/transactions",
      betBody(id, { externalTransactionId: ext, money: { amount: "5.00", currency: "BRL" } }),
      { "idempotency-key": `provider-a:${ext}` },
    );
    const transactionId = (await j(submit)).transactionId as string;

    const byId = await get(`/wagering/transactions/${transactionId}`);
    expect(byId.status).toBe(200);
    expect((await j(byId)).externalTransactionId).toBe(ext);

    const byProvider = await get(`/providers/provider-a/wagering/transactions/${ext}`);
    expect(byProvider.status).toBe(200);
    expect((await j(byProvider)).id).toBe(transactionId);

    const missing = await get(`/wagering/transactions/${uid()}`);
    expect(missing.status).toBe(404);
  });

  it("GET /wallets/:id/ledger paginates with a stable cursor", async () => {
    const { id } = await makeWallet("1000.00");
    for (let i = 0; i < 3; i++) {
      await post(
        "/wagering/transactions",
        betBody(id, {
          externalTransactionId: `p-${i}-${uid()}`,
          money: { amount: "10.00", currency: "BRL" },
        }),
        { "idempotency-key": `provider-a:p-${i}-${uid()}` },
      );
    }
    const page1 = await get(`/wallets/${id}/ledger?limit=2`);
    expect(page1.status).toBe(200);
    const b1 = await j(page1);
    expect(b1.entries).toHaveLength(2);
    expect(b1.nextCursor).toBeTruthy();

    const page2 = await get(
      `/wallets/${id}/ledger?limit=2&cursor=${encodeURIComponent(b1.nextCursor)}`,
    );
    const b2 = await j(page2);
    expect(b2.entries.length).toBeGreaterThanOrEqual(1);
    expect(b2.entries[0].id).not.toBe(b1.entries[0].id);
  });

  it("POST /wallets/:id/reconciliation reports a consistent wallet", async () => {
    const { id } = await makeWallet("100.00");
    await post(
      "/wagering/transactions",
      betBody(id, { externalTransactionId: uid(), money: { amount: "40.00", currency: "BRL" } }),
      { "idempotency-key": `provider-a:${uid()}` },
    );
    const res = await post(`/wallets/${id}/reconciliation`, {});
    expect(res.status).toBe(200);
    expect(await j(res)).toMatchObject({
      walletId: id,
      storedBalance: { amount: "60.00", currency: "BRL" },
      calculatedBalance: { amount: "60.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
    });
  });

  it("GET /metrics exposes Prometheus text after a transaction", async () => {
    const { id } = await makeWallet("100.00");
    await post(
      "/wagering/transactions",
      betBody(id, { externalTransactionId: uid(), money: { amount: "10.00", currency: "BRL" } }),
      { "idempotency-key": `provider-a:${uid()}` },
    );

    const res = await get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("wager_transactions_total");
    expect(body).toMatch(/wager_transactions_total\{[^}]*status="PROCESSED"[^}]*\}\s+\d+/);
    expect(body).toContain("wager_processing_duration_seconds");
    expect(body).toContain("wager_outbox_pending");
  });

  it("malformed money → 400 VALIDATION_ERROR", async () => {
    const { id } = await makeWallet();
    const res = await post(
      "/wagering/transactions",
      betBody(id, { externalTransactionId: uid(), money: { amount: "1.999", currency: "BRL" } }),
      { "idempotency-key": `provider-a:${uid()}` },
    );
    expect(res.status).toBe(400);
    expect((await j(res)).failureCode).toBe("VALIDATION_ERROR");
  });
});
