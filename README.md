# Distributed Wagering Processor

Serviço financeiro que processa transações de aposta
(`BET → WIN | LOSS | REFUND | ROLLBACK`) recebidas de múltiplos provedores por
**HTTP** e por **fila SQS**, mantendo a correção sob mensagens duplicadas, fora de
ordem e concorrentes.

Decisões e trade-offs: [`ARCHITECTURE.md`](ARCHITECTURE.md). Enunciado:
[`CHALLENGE.md`](CHALLENGE.md).

## Stack

| Item | Escolha |
|---|---|
| Runtime / test runner / gerenciador | Bun 1.x |
| Linguagem | TypeScript estrito |
| Framework | NestJS 11 |
| Banco | PostgreSQL 16 |
| Mensageria | AWS SQS (LocalStack) |
| ORM | MikroORM 6 |
| Observabilidade | `nestjs-pino` (logs JSON) + `prom-client` (`/metrics`) |
| Testes de integração | `testcontainers` |

## Pré-requisitos

- **Bun 1.x** — `powershell -c "irm bun.sh/install.ps1 | iex"` ou `curl -fsSL https://bun.sh/install | bash`
- **Docker** rodando — para `docker compose` e para os testes de integração, concorrência e carga

## Setup

```bash
bun install
cp .env.example .env
docker compose up -d postgres localstack
bun run migration:up
bun run start:api
```

A API sobe em `http://localhost:3000`. `/health/live`, `/health/ready` e
`/metrics` ficam abertos.

### Stack completo em containers

```bash
docker compose up --build
```

Sobe `api` + `consumer` (×3) + `outbox` (×2) + `postgres` + `localstack`, com a
migration aplicada pelo serviço `migrate`.

## Modos de processo

Todo processo serve `/health` e `/metrics`. A env `WORKER` decide o resto:

| `WORKER` | Também roda |
|---|---|
| `api` | — |
| `consumer` | consumidor SQS |
| `outbox` | relay do outbox |
| `pending-reference` | reprocessador de `PENDING_REFERENCE` |
| `all` (padrão) | tudo no mesmo processo |

## Comandos

| Comando | O quê |
|---|---|
| `bun run start:api` \| `start:consumer` \| `start:outbox` \| `start:pending-reference` | sobe um modo de processo |
| `bun run migration:up` \| `migration:down` \| `migration:fresh` \| `migration:create` | migrations |
| `bun run typecheck` \| `bun run lint` | `tsc --noEmit` \| ESLint |
| `bun test` \| `bun run test:unit` | unitários, sem Docker |
| `bun run test:integration` | e2e HTTP + SQS, containers via `testcontainers` |
| `bun run test:concurrency` | concorrência, paralelismo real |
| `bun run test:e2e` \| `bun run test:all` | integração + concorrência \| unit + e2e |
| `bun run test:load` | teste de carga |

## API HTTP

Todos os endpoints, exceto `/health/*` e `/metrics`, passam pelo `AuthGuard`:
pass-through com `AUTH_MODE=none` (padrão), assinado com `AUTH_MODE=hmac`.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet |
| `GET` | `/wallets/:walletId` | consulta a wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | ledger paginado, cursor opaco e estável |
| `POST` | `/wallets/:walletId/reconciliation` | saldo materializado × soma do ledger |
| `POST` | `/wagering/transactions` | submete transação, header `Idempotency-Key` obrigatório |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET` | `/health/live` \| `/health/ready` \| `/metrics` | abertos |

### Status de `POST /wagering/transactions`

| Situação | HTTP | Corpo |
|---|---|---|
| Aplicada | `201` | `status: PROCESSED`, `idempotentReplay: false` |
| Replay idempotente | `200` | `idempotentReplay: true` |
| Aguardando referência | `202` | `status: PENDING_REFERENCE` |
| Payload inválido | `400` | `failureCode: VALIDATION_ERROR` |
| Conflito de idempotência / wallet duplicada | `409` | `failureCode` |
| Rejeição de negócio | `422` | `status: REJECTED`, `failureCode` |
| Wallet / transação inexistente | `404` | `failureCode` |
| Falha transitória de infraestrutura | `503` | `failureCode: INTERNAL_ERROR` |

### Exemplos

```bash
curl -sS -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```bash
curl -sS -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId":"provider-a","externalTransactionId":"transaction-123",
    "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<WALLET_ID>",
    "roundId":"round-987","gameId":"fortune-chimp",
    "kind":"BET","money":{"amount":"25.00","currency":"BRL"}
  }'
```

## Autenticação HMAC

Com `AUTH_MODE=hmac`, toda requisição aos controllers de wallets / wagering /
providers precisa de três headers:

| Header | Conteúdo |
|---|---|
| `X-Provider-Id` | id do provedor |
| `X-Timestamp` | unix time em segundos, dentro de `HMAC_TIMESTAMP_TOLERANCE_SECONDS` (padrão 300) |
| `X-Signature` | HMAC-SHA256 hex do segredo do provedor sobre a string abaixo |

String assinada — cinco linhas unidas por `\n`:

```
METHOD
PATH                  com query string
PROVIDER_ID
UNIX_TIMESTAMP
SHA256_HEX(rawBody)   "" quando não há body
```

```bash
AUTH_MODE=hmac
PROVIDER_SECRETS='{"provider-a":"um-segredo-longo-e-aleatorio"}'
```

Respostas: **401** para headers ausentes, provedor desconhecido, assinatura
inválida ou timestamp fora da janela; **403** quando o `providerId` do body difere
do autenticado. O canal SQS não é autenticado.

## Fila SQS

O consumidor reusa o mesmo use case `ProcessWagerTransaction` da API. A linha do
inbox (`consumer_name`, `message_id`) é gravada na mesma transação SQL da mudança
financeira; o `ack` só ocorre após o commit.

Mensagem de entrada (`wager-transactions.fifo`):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "walletId": "<WALLET_ID>",
    "roundId": "round-987", "gameId": "fortune-chimp",
    "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Eventos publicados pelo relay do outbox em `wager-events.fifo`:
`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`,
`WagerTransactionPendingReference`.

## Variáveis de ambiente

Lista completa, agrupada e com valores padrão em [`.env.example`](.env.example).
Os grupos são: runtime, autenticação, PostgreSQL, SQS/LocalStack, consumidor,
outbox e referências pendentes.

## Testes

```bash
bun test              # unitários, sem Docker
bun run test:e2e      # integração + concorrência, Postgres + LocalStack via testcontainers
```

- **Unitários** (`test/unit`): `Money`, `Wallet`, `WalletLedgerEntry`,
  `WagerTransaction`, JSON canônico + hash, verificador HMAC, e os use cases
  contra fakes em memória — inclui o cenário obrigatório do item 8.
- **Integração** (`test/integration`): stack HTTP completo, autenticação HMAC, e
  consumidor SQS + relay do outbox contra Postgres + LocalStack reais.
- **Concorrência** (`test/concurrency`): paralelismo real — mesma aposta ×50, o
  race do item 8, hot wallet, 3 instâncias disputando uma wallet pelo lock do
  banco, crash entre commit e ack, dois publishers no mesmo outbox, referência
  fora de ordem, restart. Toda asserção termina em `wallet.balance == replay(ledger)`.

Docker precisa estar rodando para `test:integration`, `test:concurrency` e
`test:load`; os containers são derrubados ao final.

## Teste de carga

```bash
bun run test:load
```

Aplica carga closed-loop de `POST /wagering/transactions` sobre wallets quentes e
frias, com a API e o relay do outbox no mesmo processo, e imprime um relatório
Markdown (throughput, p50/p95/p99, taxa de erro, `wager_lock_conflicts_total`,
outbox lag). Parametrizável por `LOAD_*` (ver [`test/load/run.ts`](test/load/run.ts)).
Exemplo em [`docs/LOADTEST.md`](docs/LOADTEST.md).

## Estrutura

```
src/
  domain/          TypeScript puro — value objects, agregados, eventos, erros
  application/     use cases + ports (interfaces); canonical-json + wager-payload
  infrastructure/  persistence (MikroORM + UnitOfWork + migration), messaging
                   (SQS + outbox), workers, http (controllers, AuthGuard, filtro,
                   pipe Zod), observability, health, system
  config/          AppConfig validado com Zod
test/  unit/  integration/  concurrency/  load/  support/
```

## Limitações conhecidas

- HMAC é opt-in com segredos em env; produção precisa de secrets manager + rotação.
- Reversão parcial fora de escopo: `REFUND`/`ROLLBACK` devem ter o valor da referência.
- Ledger de partidas dobradas não implementado (diferencial opcional).
- Região única, banco único; a tabela `wallet` não é particionada.
