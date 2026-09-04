# Load test report

## Environment

| | |
|---|---|
| runtime | Bun 1.4.0 |
| CPUs | 12 × AMD Ryzen 5 5500                                |
| memory | 15.9 GiB |
| Postgres | `postgres:16-alpine` (testcontainers) |
| SQS | `localstack/localstack:3` (testcontainers) |
| process mode | `WORKER=outbox` (HTTP API + transactional-outbox relay) |
| date | 2026-09-04T02:08:17.142Z |

## Methodology

Closed-loop: **16** concurrent virtual users, each issuing
`POST /wagering/transactions` (BET 5.00 BRL, fresh `Idempotency-Key`) in a
tight loop for **10s**, over **12**
wallets (**3** of them "hot", receiving ~60% of the traffic to create
per-wallet lock contention). Wallet balance 100000.00 BRL so the load
measures throughput and lock-wait latency, not fund exhaustion. The outbox relay
polls every 250ms; `wager_outbox_*` sampled from `/metrics` every 500ms.

## Results

| Metric | Value |
|---|---|
| requests | 1519 |
| wall time | 10.12 s |
| throughput | **150 req/s** |
| 2xx (applied/replayed/pending) | 1519 |
| 422 (business rejections) | 0 |
| 5xx / transport errors | 0 |
| error rate (5xx) | 0.00 % |
| idempotent replays | 0 |

### Latency (ms)

| p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|
| 91.6 | 170.9 | 207.9 | 322.6 | 423.0 |

### Concurrency & outbox

| Metric | Value |
|---|---|
| `wager_lock_conflicts_total` | 0 |
| `wager_transactions_total` (PROCESSED) | 1519 |
| outbox pending — peak during load | 2058 |
| outbox lag seconds — peak during load | 5.36 |
| outbox drained after load in | 13.2 s |

> `wager_lock_conflicts_total = 0` is expected: the per-wallet `FOR UPDATE`
> lock serializes contending transactions without deadlocks — contention shows
> up as p99 latency, not as errors.
>
> Outbox lag is bounded by a **single** relay doing one `SendMessage` per event
> against LocalStack. Each accepted BET emits 2 events, so sustained throughput
> above ~½ the relay's publish rate builds a backlog that drains after the load
> stops. Production runs multiple relay replicas (docker-compose starts 2) and/or
> batched `SendMessageBatch`.
