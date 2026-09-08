# ARCHITECTURE

Decisões, trade-offs e limitações do **Distributed Wagering Processor**.
Identificadores de código, SQL e caminhos ficam em inglês; o texto, em português.
Setup e comandos em [`README.md`](README.md); enunciado em [`CHALLENGE.md`](CHALLENGE.md).

## 1. Camadas

```
domain/          TypeScript puro. Sem NestJS, sem ORM, sem I/O.
application/     use cases + ports. Um use case por operação de negócio,
                 reusado por todo adaptador de entrada.
infrastructure/  adaptadores: repositórios MikroORM + Unit of Work, SQS,
                 controllers HTTP, workers, logging, métricas, config.
```

Dependência: `infrastructure → application → domain`. O domínio não depende de
nada. As ports vivem em `application/ports` e são implementadas em `infrastructure`.

O item 10 exige que o consumidor da fila reuse o mesmo use case da entrada HTTP.
`ProcessWagerTransaction` recebe um objeto de comando simples: o controller o monta
a partir do body HTTP + header `Idempotency-Key`, o consumidor a partir do body da
mensagem SQS. Nenhum adaptador contém lógica de negócio.

## 2. Money

- Value object `Money` sobre um `Decimal` (decimal.js) num `Decimal.clone()`
  isolado — nenhum outro código do processo altera sua precisão ou arredondamento.
- **Nenhum `number`** cruza fronteira; `Money` é o único tipo monetário, garantido
  por regra de lint.
- **Escala fixa em 2.** A entrada é uma string decimal simples (sem sinal, sem
  notação científica, sem `NaN`); mais de 2 casas é rejeitado; `"25"` normaliza
  para `"25.00"`.
- `Money.from`, a factory da fronteira não confiável, rejeita negativos. Valores
  negativos só surgem de aritmética confiável (`subtract`, `negate`).
- Persistência: `NUMERIC(20,2)` + `VARCHAR(3)` em colunas separadas. O driver `pg`
  devolve `NUMERIC` como string, reidratada por `Money.from`. O domínio nunca vê um
  tipo monetário do ORM.
- Imutável, sem setters. O modelo é multi-moeda e os conflitos são testados
  (`CurrencyMismatchError`).

## 3. Invariantes no schema

O item 5.9 exige que unicidade, imutabilidade e não-negatividade vivam no
**schema**, não só no código. Tudo em `Migration20260903000000_init`, SQL escrito
à mão:

| Invariante | Mecanismo |
|---|---|
| Uma wallet por `(playerId, currency)` | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` na wallet e nas colunas de saldo do ledger |
| `version` válida | `CHECK (version >= 1)` + `UPDATE ... WHERE version = prev` |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Reversão exige referência | `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_... IS NOT NULL)` |
| `processed_at` sse `PROCESSED`; `failure_code` só em `REJECTED`/`FAILED` | `CHECK` |
| Valores positivos | `CHECK (amount > 0)` em `wager_transaction` e `wallet_ledger_entry` |
| ≤ 1 lançamento por wallet por transação | `UNIQUE (wallet_id, transaction_id)` |
| Ledger append-only | trigger `BEFORE UPDATE OR DELETE` que levanta exceção |
| Aritmética do lançamento | `CHECK` ligando `balance_before/after`, `amount`, `direction` |
| Uma reversão por tipo de operação | índice `UNIQUE` parcial `(reference_transaction_id, kind)` para status ativos |
| Dedup do inbox | `PRIMARY KEY (consumer_name, message_id)` |

Os agregados de domínio não carregam decorators do ORM. O MikroORM mapeia
entidades anêmicas separadas (`entities.ts`); mapeadores puros (`mappers.ts`)
convertem entidade ⇄ agregado via `toState()` / `rehydrate()`.

## 4. Concorrência — a unidade é `walletId`

**Lock pessimista na linha da wallet.** Toda transação financeira roda dentro de
uma única transação SQL que começa com:

```
SELECT ... FROM wallet WHERE id = :walletId FOR UPDATE
```

(`em.transactional()` + `LockMode.PESSIMISTIC_WRITE`). Só então o agregado `Wallet`
é reidratado, mutado e persistido junto com o lançamento do ledger, a linha do
inbox, a linha da transação e a linha do outbox.

| Alternativa | Por que não escolhida |
|---|---|
| **`FOR UPDATE` por wallet** | Serializa apenas o trabalho da mesma wallet; wallets diferentes seguem em paralelo. |
| Optimistic (`version` CAS) + retry | Uma hot wallet degenera em tempestade de retry e a latência fica imprevisível. Mantido como defesa em profundidade — a coluna `version` ainda é escrita e verificada. |
| `UPDATE ... SET balance = balance - x WHERE balance >= x` | Empurra a regra de domínio para o SQL e não compõe com as escritas multi-linha (ledger + outbox + inbox). |
| Lock global / advisory compartilhado | Proibido pelo item 5.6. |

A ordenação e o dedup do SQS FIFO (`MessageGroupId = walletId`) são otimizações que
reduzem contenções, nunca a garantia de correção — as constraints do banco são a
última linha de defesa.

### Cenário obrigatório (item 8)

Saldo `100.00`, dois `BET 80.00` concorrentes:

1. Tx A trava a linha, lê `100.00`, debita → `20.00`, escreve o ledger + o outbox,
   commita, libera o lock.
2. Tx B estava bloqueada; agora lê o `20.00` **commitado**, `Wallet.debit` lança
   `InsufficientFundsError` → transação `REJECTED` com `INSUFFICIENT_FUNDS`, sem
   lançamento, evento `WagerTransactionRejected` na mesma transação.
3. Final: um `PROCESSED`, um `REJECTED`, saldo `20.00`, exatamente um `DEBIT`. Uma
   redelivery bate na idempotência / inbox e replica o resultado — sem segundo débito.

## 5. Idempotência

- **Fonte da verdade:** o header `Idempotency-Key` (valor recomendado
  `"{providerId}:{externalTransactionId}"`); a mensagem SQS carrega a mesma chave.
  Persistido em `UNIQUE (idempotency_key)`.
- **Payload hash:** `sha256(canonicalJson(businessFields))` — chaves de objeto
  ordenadas recursivamente, sem espaços, membros `undefined` descartados,
  alimentado ao hash como UTF-8. `businessFields` são os campos de negócio com
  `amount` **normalizado**; metadados de transporte (header, messageId, occurredAt)
  não entram.
- **Replay vs. conflito:** mesma chave + mesmo hash → resposta original com
  `idempotentReplay: true` (HTTP 200). Mesma chave + hash diferente → HTTP 409,
  nunca replay. `OPENING` nunca pode ser submetido externamente.
- **Saldo observado:** toda transação terminal grava `observed_balance`, o saldo no
  momento do processamento. Um replay retorna exatamente esse valor, então
  "repetir uma operação processada → resultado original, incluindo o saldo daquele
  momento" (item 7.7) vale também para `LOSS` e `REJECTED`, não só para os kinds que
  deixam lançamento no ledger.
- **Sob o lock da wallet:** as pré-checagens por `SELECT` (`findByIdempotencyKey`,
  `findByProviderAndExternalId`, `find` do inbox) são **autoritativas** — o código
  nunca captura um `INSERT` que falhou para decidir, porque um erro de constraint
  aborta a transação Postgres inteira (ver item 12). Nada em memória: a garantia é a
  linha do banco.

## 6. Mensageria

`WagerTransactionConsumer`, `OutboxRelayWorker` e o worker de referências pendentes
se auto-habilitam por `WORKER`; todo processo ainda serve `/health` e `/metrics`.

### Inbox

PK `inbox_message (consumer_name, message_id)`. Quando `ProcessWagerTransaction`
recebe um `command.inbox`, escreve a linha **dentro da mesma transação SQL** da
escrita financeira. O `ack` (SQS `DeleteMessage`) só acontece **depois do commit**
(item 10). Uma redelivery do mesmo `messageId` encontra a linha do inbox e replica
o resultado armazenado sem segundo efeito.

### Outbox transacional

`outbox_message` é escrito na mesma transação SQL que todo o resto (item 11).
`PublishOutbox.execute()` roda um ciclo de transação única: `claimDue` com
`FOR UPDATE SKIP LOCKED` → para cada linha, `publish` → `markPublished` ou
`scheduleRetry` (backoff exponencial, teto de 1h) → commit. As linhas ficam
travadas o ciclo inteiro, então relays concorrentes não as tocam. Uma publicação
duplicada é segura: os consumidores são idempotentes e a fila de eventos é FIFO
com `MessageDeduplicationId = eventId`. Trade-off: a transação SQL fica aberta
durante as chamadas ao SQS de um pequeno batch — aceitável nesta escala.

### Ordenação

O SQS FIFO de entrada com `MessageGroupId = walletId` dá ordenação por wallet e
dedup best-effort do broker. Nenhum dos dois é confiado para correção.

### Falha no consumidor (item 10)

| Classe | Ação |
|---|---|
| Rejeição de negócio | não é erro — persiste `REJECTED` + evento; o consumidor dá `ack` |
| Transitória — deadlock, SQS 5xx, desconhecida | não deleta; a visibilidade expira → redelivery; redrive → DLQ após `maxReceiveCount` |
| Permanente — payload ruim, wallet inexistente, JSON impossível de parsear | copia para a DLQ com um atributo `failureReason`, depois deleta da origem |

`SIGTERM`: para o loop de poll, aguarda o batch em voo terminar, depois sai.

## 7. Referências fora de ordem (item 7.1)

`REFUND` / `ROLLBACK` resolvem a referência por
`(provider_id, reference_external_transaction_id)`. Se ela está ausente ou ainda
não está `PROCESSED`, a transação é gravada como `PENDING_REFERENCE` e um evento
`WagerTransactionPendingReference` é emitido (HTTP 202).

Com a referência `PROCESSED`, `validateReferenceMatch` verifica, nesta ordem:

| Checagem | Failure code (`REJECTED` + evento) |
|---|---|
| `REFUND` só sobre `BET`; `ROLLBACK` sobre `BET` / `WIN` / `REFUND` (7.3) | `REFERENCE_KIND_MISMATCH` |
| mesmo player, wallet, moeda, rodada (7.2) | `REFERENCE_ATTRIBUTES_MISMATCH` |
| valor exatamente igual ao da referência (7.5) | `AMOUNT_MISMATCH` |
| ainda não revertida por este tipo (7.4) | `ALREADY_REVERSED` |

Então aplica: `REFUND` credita; `ROLLBACK` posta o **inverso da direção de ledger
da própria referência**, então um `ROLLBACK` de um `WIN` debita e pode levantar
`REVERSAL_WOULD_OVERDRAW` — código distinto de `INSUFFICIENT_FUNDS` (7.9).

O worker `ReprocessPendingReferences` (`setInterval` não sobreposto) reprocessa
cada linha `PENDING_REFERENCE` sob o lock da própria wallet, com backoff
exponencial. Desiste em `PENDING_REFERENCE_MAX_ATTEMPTS` (padrão 12) **ou**
`PENDING_REFERENCE_TTL_HOURS` (padrão 24), o que vier primeiro → `REJECTED` com
`REFERENCE_NOT_FOUND`. O bookkeeping de tentativas/TTL vive no agregado
`WagerTransaction`.

O caminho principal e o worker compartilham um único applier
(`applyAcceptedTransaction`), o mesmo que `ProcessWagerTransaction` usa para
BET/WIN/LOSS — um único caminho de código escreve saldo + ledger + eventos.

## 8. Status HTTP (item 9)

A tabela completa está no [`README.md`](README.md). As cinco situações que o item 9
pede para distinguir mapeiam para códigos distintos: `400` (payload) / `409`
(conflito de idempotência) / `422` (rejeição de negócio) / `202` (aguardando
referência) / `503` (transitória).

O `WageringController` define o código a partir de `result.status` +
`result.idempotentReplay`; o `DomainExceptionFilter` mapeia `ApplicationError` por
`kind` e `DomainError` vazado → 422. Uma **rejeição** de negócio nunca é lançada —
volta como resultado normal `{ status: "REJECTED", failureCode }`. `404` é para
wallet / transação inexistente nas consultas.

## 9. Autenticação HMAC (opt-in via `AUTH_MODE`)

- `none` (padrão) — pass-through. Mantém dev e as suites de teste sem mudança.
- `hmac` — requisições aos controllers de wallets / wagering / providers precisam
  de `X-Provider-Id`, `X-Timestamp` e `X-Signature`.

A string assinada (`infrastructure/auth/hmac.ts`) são cinco linhas unidas por
`\n`: `METHOD`, `PATH` (com query), `PROVIDER_ID`, `UNIX_TIMESTAMP`,
`SHA256_HEX(rawBody)`.

O guard resolve o segredo via `ProviderCredentialsPort` (`EnvProviderCredentials`
lê `PROVIDER_SECRETS`), recomputa o HMAC sobre `req.rawBody` e compara com
`crypto.timingSafeEqual`. Rejeita com:

- **401 `UNAUTHENTICATED`** — headers ausentes, provedor desconhecido, assinatura
  inválida, ou `X-Timestamp` fora de `HMAC_TIMESTAMP_TOLERANCE_SECONDS` (padrão 300s).
- **403 `FORBIDDEN`** — o body carrega `providerId` diferente do autenticado.

Cada rejeição incrementa `wager_auth_failures_total{reason}` e é logada em `warn`;
`x-signature` está na lista de redação dos logs.

**Replay:** sem cache de nonce — a janela de timestamp limita a repetição de uma
requisição assinada, e uma repetição dentro dela carrega o mesmo `Idempotency-Key`,
então `ProcessWagerTransaction` apenas replica o resultado armazenado.

**Fora do guard:** o caminho SQS continua canal interno confiável (item 2), sem
HMAC. Em produção, `EnvProviderCredentials` daria lugar a um secrets manager ou a
uma tabela `provider_credential` com rotação — o mesmo port, outra implementação.

## 10. Observabilidade

- **Health** — `/health/live` (processo vivo) e `/health/ready`
  (`ReadinessService` pinga o PostgreSQL com `select 1` e o SQS com `ListQueues`;
  200 só quando os dois estão `up`, senão 503).
- **Logs** — `nestjs-pino`, só JSON, timestamps ISO. `pino-http` loga cada
  requisição com um `correlationId` (do header ou gerado e devolvido), método, url,
  status, `responseTime` — nunca headers ou body. A redação remove `authorization`,
  `cookie`, `req.body` e qualquer `*.money` / `*.amount` / `*.balance` /
  `*.payload` / `*.data`. `/health/*` e `/metrics` ficam fora do log de requisição.
- **Métricas** — `prom-client` num `Registry` por instância, em `GET /metrics`.
  Além das padrão de processo (prefixo `wager_`), métricas de negócio custom:
  contadores de transações por `{kind,status,source}`, replays idempotentes,
  duplicados, retries, mensagens em DLQ, conflitos de lock, falhas de auth por
  `{reason}`; gauges de outbox (`pending`, `lag_seconds`); histograma
  `wager_processing_duration_seconds`; mismatches de reconciliação.
- **Telemetria por etapa** — dois histogramas isolam onde o tempo vai nos pontos
  de contenção já discutidos nos itens 4 e 6, sem a infraestrutura de um tracer
  distribuído (OpenTelemetry é diferencial opcional, item 12):
  `wager_wallet_lock_wait_seconds`, medido em `MikroUnitOfWork.run()` como o
  tempo entre pedir e obter o `SELECT ... FOR UPDATE` da wallet (separa fila de
  lock de tempo de processamento — cresce sob uma hot wallet, fica ~0 em
  wallets distintas); e `wager_outbox_publish_duration_seconds{eventType}`,
  medido em `SqsMessagePublisher.publish()` como a latência de um único
  `SendMessage` (separa lentidão do broker de acúmulo por volume no
  `wager_outbox_lag_seconds`). Ambos são passados por callback opcional ao
  adaptador — a mesma forma como `onLockConflict` já liga
  `MikroUnitOfWork` ao `MetricsService` — então nenhuma camada de domínio ou
  de aplicação toma conhecimento de métricas.

## 11. Testes (item 13)

Quatro níveis; o detalhe de cada suite está no [`README.md`](README.md).

- **Unitários** (`test/unit`) — value objects, agregados, JSON canônico + hash,
  verificador HMAC, e os use cases contra fakes das portas em memória, incluindo o
  cenário do item 8. Sem I/O.
- **Integração** (`test/integration`) — stack HTTP, autenticação HMAC, consumidor
  SQS + relay do outbox contra Postgres + LocalStack reais. `testcontainers` sobe
  um stack por processo `bun test`, parado no preload; sem `docker compose`.
- **Concorrência** (`test/concurrency`) — paralelismo real contra esse Postgres,
  incluindo 3 instâncias independentes disputando uma wallet pelo lock do banco.
  Todo caso afirma `wallet.balance == replay(ledger)`.
- **Carga** (`bun run test:load`) — closed-loop com relatório Markdown.

## 12. Notas de MikroORM

- **`em.transactional(cb)` passa um EM com escopo de transação** — o EM do `fork()`
  externo *não* está na transação. `MikroUnitOfWork` usa o EM do callback para o
  lock `FOR UPDATE` e para todos os repositórios.
- **Nunca misture `persistAndFlush` com `nativeUpdate` na mesma linha** dentro de
  um `em.transactional`. O `flush()` do commit reescreve a linha a partir do
  identity map obsoleto e apaga o `nativeUpdate` (perdíamos `failure_code` /
  `observed_balance` assim). Por isso os repositórios usam `em.insert()` /
  `em.insertMany()` + `em.nativeUpdate()`, mapeando entidade ⇄ agregado à mão, sem
  change tracking.
- **Um `INSERT` que falha aborta a transação Postgres inteira**, então não dá para
  capturar uma violação de unicidade e seguir consultando na mesma transação. Sob o
  lock da wallet as pré-checagens `SELECT` já são autoritativas.

## 13. Limitações / fora de escopo

- HMAC é opt-in (`AUTH_MODE=hmac`) com segredos em env; um deploy real precisa de
  secrets manager + rotação. O caminho SQS não é autenticado (canal interno, item 2).
- Reversão parcial de refund/rollback fora de escopo (item 7 regra 5): o valor deve
  ser igual ao da referência.
- Ledger de partidas dobradas não implementado (diferencial opcional 6.4).
- Região única, banco único; a tabela `wallet` não é particionada.
- `ajv@^8` é fixado como devDependency direta para resolver um conflito de hoisting
  transitivo do `umzug` (via `@mikro-orm/migrations`), que faz o migrator carregar
  sob o Bun.
