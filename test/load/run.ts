/**
 * Teste de carga — `bun run test:load`.
 *
 * Sobe a stack (testcontainers), a API HTTP e o relay do outbox num único
 * processo, e então aplica uma carga em malha fechada de
 * `POST /wagering/transactions` sobre um pool de wallets (algumas "quentes"
 * para criar contenção de lock). Imprime um relatório em Markdown (vazão,
 * p50/p95/p99, taxa de erro, conflitos de lock, atraso do outbox) no stdout e
 * em docs/LOADTEST.md.
 *
 * Não faz nenhuma asserção — é um diagnóstico. A honestidade do setup importa
 * mais do que o número bruto (README item 14 "Diferenciais opcionais").
 */
import "reflect-metadata";
import { cpus, totalmem } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";

import { getTestStack } from "../support/containers";
import { AppModule } from "../../src/app.module";

const env = {
  concurrency: Number(process.env.LOAD_CONCURRENCY ?? 16),
  durationMs: Number(process.env.LOAD_DURATION_MS ?? 10_000),
  wallets: Number(process.env.LOAD_WALLETS ?? 12),
  hotWallets: Number(process.env.LOAD_HOT_WALLETS ?? 3),
  bet: process.env.LOAD_BET ?? "5.00",
  walletBalance: process.env.LOAD_WALLET_BALANCE ?? "100000.00",
};

const uid = (): string => crypto.randomUUID();
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const pct = (s: number[], p: number): number =>
  s.length ? (s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0) : 0;
const metric = (text: string, name: string): number => {
  const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, "m"));
  return m ? Number(m[1]) : 0;
};

async function main(): Promise<void> {
  console.error("starting containers…");
  await getTestStack();
  process.env.WORKER = "outbox"; // HTTP + relay do outbox
  process.env.LOG_LEVEL = "silent";
  process.env.OUTBOX_POLL_INTERVAL_MS = "200";
  process.env.OUTBOX_BATCH_SIZE = "100";

  const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(0);
  const base = (await app.getUrl()).replace("[::1]", "127.0.0.1").replace("::1", "127.0.0.1");

  // ---- fixtures --------------------------------------------------------------
  const walletIds: string[] = [];
  for (let i = 0; i < env.wallets; i++) {
    const res = await fetch(`${base}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: uid(),
        initialBalance: { amount: env.walletBalance, currency: "BRL" },
      }),
    });
    walletIds.push(((await res.json()) as { id: string }).id);
  }
  const hot = walletIds.slice(0, Math.max(1, env.hotWallets));
  const pickWallet = (): string =>
    Math.random() < 0.6 ? hot[Math.floor(Math.random() * hot.length)]! : walletIds[Math.floor(Math.random() * walletIds.length)]!;

  // ---- carga ---------------------------------------------------------------
  const latencies: number[] = [];
  const status: Record<string, number> = {};
  let replays = 0;
  const deadline = Date.now() + env.durationMs;

  const lagSamples: number[] = [];
  const pendingSamples: number[] = [];
  const sampler = setInterval(() => {
    void fetch(`${base}/metrics`)
      .then((r) => r.text())
      .then((t) => {
        lagSamples.push(metric(t, "wager_outbox_lag_seconds"));
        pendingSamples.push(metric(t, "wager_outbox_pending"));
      })
      .catch(() => undefined);
  }, 500);

  const worker = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const ext = uid();
      const started = performance.now();
      try {
        const res = await fetch(`${base}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": `load:${ext}` },
          body: JSON.stringify({
            providerId: "load",
            externalTransactionId: ext,
            playerId: uid(),
            walletId: pickWallet(),
            roundId: "load-round",
            gameId: "load-game",
            kind: "BET",
            money: { amount: env.bet, currency: "BRL" },
          }),
        });
        latencies.push(performance.now() - started);
        status[String(res.status)] = (status[String(res.status)] ?? 0) + 1;
        if (res.status < 400) {
          const body = (await res.json()) as { idempotentReplay?: boolean };
          if (body.idempotentReplay) replays += 1;
        }
      } catch (err) {
        latencies.push(performance.now() - started);
        status.error = (status.error ?? 0) + 1;
        void err;
      }
    }
  };

  const runStart = Date.now();
  await Promise.all(Array.from({ length: env.concurrency }, () => worker()));
  const wallMs = Date.now() - runStart;
  clearInterval(sampler);

  // mede quanto tempo o relay único leva para escoar o backlog que acumulou
  const drainStart = Date.now();
  let drainMs = -1;
  for (let i = 0; i < 240; i++) {
    const t = await (await fetch(`${base}/metrics`)).text();
    if (metric(t, "wager_outbox_pending") === 0) {
      drainMs = Date.now() - drainStart;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const finalMetrics = await (await fetch(`${base}/metrics`)).text();

  // ---- relatório ----------------------------------------------------------
  const s = sorted(latencies);
  const total = latencies.length;
  const ok = (status["200"] ?? 0) + (status["201"] ?? 0) + (status["202"] ?? 0);
  const rejected422 = status["422"] ?? 0;
  const server5xx =
    (status["500"] ?? 0) + (status["502"] ?? 0) + (status["503"] ?? 0) + (status.error ?? 0);

  const report = `# Load test report

## Environment

| | |
|---|---|
| runtime | Bun ${Bun.version} |
| CPUs | ${cpus().length} × ${cpus()[0]?.model ?? "unknown"} |
| memory | ${(totalmem() / 1024 ** 3).toFixed(1)} GiB |
| Postgres | \`postgres:16-alpine\` (testcontainers) |
| SQS | \`localstack/localstack:3\` (testcontainers) |
| process mode | \`WORKER=outbox\` (HTTP API + transactional-outbox relay) |
| date | ${new Date().toISOString()} |

## Methodology

Closed-loop: **${env.concurrency}** concurrent virtual users, each issuing
\`POST /wagering/transactions\` (BET ${env.bet} BRL, fresh \`Idempotency-Key\`) in a
tight loop for **${(env.durationMs / 1000).toFixed(0)}s**, over **${env.wallets}**
wallets (**${hot.length}** of them "hot", receiving ~60% of the traffic to create
per-wallet lock contention). Wallet balance ${env.walletBalance} BRL so the load
measures throughput and lock-wait latency, not fund exhaustion. The outbox relay
polls every 200ms (batch 100); \`wager_outbox_*\` sampled from \`/metrics\` every 500ms.

## Results

| Metric | Value |
|---|---|
| requests | ${total} |
| wall time | ${(wallMs / 1000).toFixed(2)} s |
| throughput | **${(total / (wallMs / 1000)).toFixed(0)} req/s** |
| 2xx (applied/replayed/pending) | ${ok} |
| 422 (business rejections) | ${rejected422} |
| 5xx / transport errors | ${server5xx} |
| error rate (5xx) | ${((server5xx / total) * 100).toFixed(2)} % |
| idempotent replays | ${replays} |

### Latency (ms)

| p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|
| ${pct(s, 50).toFixed(1)} | ${pct(s, 90).toFixed(1)} | ${pct(s, 95).toFixed(1)} | ${pct(s, 99).toFixed(1)} | ${(s.at(-1) ?? 0).toFixed(1)} |

### Concurrency & outbox

| Metric | Value |
|---|---|
| \`wager_lock_conflicts_total\` | ${metric(finalMetrics, "wager_lock_conflicts_total")} |
| \`wager_transactions_total\` (PROCESSED) | ${metric(finalMetrics, 'wager_transactions_total{kind="BET",status="PROCESSED",source="http"}')} |
| outbox pending — peak during load | ${Math.max(0, ...pendingSamples)} |
| outbox lag seconds — peak during load | ${Math.max(0, ...lagSamples).toFixed(2)} |
| outbox drained after load in | ${drainMs < 0 ? "> 120 s (still draining)" : `${(drainMs / 1000).toFixed(1)} s`} |

> \`wager_lock_conflicts_total = 0\` is expected: the per-wallet \`FOR UPDATE\`
> lock serializes contending transactions without deadlocks — contention shows
> up as p99 latency, not as errors.
>
> Outbox lag is bounded by a **single** relay doing one \`SendMessage\` per event
> against LocalStack. Each accepted BET emits 2 events, so sustained throughput
> above ~½ the relay's publish rate builds a backlog that drains after the load
> stops. Production runs multiple relay replicas (docker-compose starts 2) and/or
> batched \`SendMessageBatch\`.
`;

  await mkdir("docs", { recursive: true });
  await writeFile("docs/LOADTEST.md", report, "utf8");
  console.log(report);

  await app.close();
  process.exit(0);
}

void main();
