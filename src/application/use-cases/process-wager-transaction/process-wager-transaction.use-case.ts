import { Money, type MoneyProps } from "../../../domain/money/money";
import { DomainError } from "../../../domain/shared/domain-error";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import { ReferenceRequiredError } from "../../../domain/wagering/wager-transaction.errors";
import { FailureCode } from "../../../domain/wagering/failure-code";
import { WagerTransactionPendingReference } from "../../../domain/messaging/events";
import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";

import {
  IdempotencyConflictError,
  ValidationError,
  WalletNotFoundError,
} from "../../application-error";
import type { Clock, IdGenerator } from "../../ports/system.ports";
import type { UnitOfWork } from "../../ports/unit-of-work.port";
import { hashBusinessFields, toBusinessFields } from "../../wager-payload";
import {
  applyAcceptedTransaction,
  eventContext,
  rejectTransaction,
  toFailureCode,
  validateReferenceMatch,
  type ProcessingContext,
} from "../wager-processing";

/** Presente quando o comando vem do consumidor SQS (README itens 10 e 11). */
export interface InboxRef {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  causationId?: string;
  /**
   * Quando setado, a linha do inbox é escrita na MESMA transação SQL da mudança
   * financeira. Um choque em `(consumerName, messageId)` significa que a mensagem
   * já foi tratada → o resultado armazenado é replicado.
   */
  inbox?: InboxRef;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado no processamento; omitido quando desconhecido (ainda pendente). */
  balance?: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

/**
 * O único use case por trás tanto do endpoint HTTP quanto do consumidor SQS
 * (README item 10). Trata BET / WIN / LOSS / REFUND / ROLLBACK.
 *
 * Concorrência: o corpo inteiro roda dentro de uma transação SQL com a linha da
 * wallet travada `FOR UPDATE` (`uow.run({ lockWallet })`), então operações na
 * mesma wallet são serializadas enquanto wallets diferentes rodam em paralelo
 * (item 8).
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    let money: Money;
    try {
      money = Money.from(command.money);
    } catch (err) {
      throw new ValidationError(err instanceof DomainError ? err.message : "Invalid money");
    }

    if (command.kind === WagerTransactionKind.Opening) {
      throw new ValidationError("OPENING transactions cannot be submitted");
    }

    const payloadHash = hashBusinessFields(toBusinessFields(command, money));
    const now = this.clock.now();
    const ctx: ProcessingContext = {
      now,
      correlationId: command.correlationId ?? command.idempotencyKey,
      causationId: command.causationId,
      ids: this.ids,
    };

    return this.uow.run(
      { lockWallet: command.walletId, name: `process-${command.kind}` },
      async (repos) => {
        // Tudo abaixo roda com a linha da wallet travada FOR UPDATE, então
        // qualquer duplicado concorrente desta wallet é serializado atrás de nós
        // e enxerga as nossas linhas commitadas. Isso torna as pré-checagens
        // SELECT autoritativas — nunca dependemos de capturar um INSERT que
        // falhou (o que envenenaria a transação Postgres).

        // Dedup do inbox (caminho SQS): a linha commita atomicamente com a
        // mudança financeira; se ela já existe, esta mensagem já foi processada.
        if (command.inbox) {
          const seen = await repos.inbox.find(
            command.inbox.consumerName,
            command.inbox.messageId,
          );
          if (seen) {
            const done = await repos.transactions.findByIdempotencyKey(command.idempotencyKey);
            if (done) return replayResult(done);
            throw new Error(
              `inbox row ${command.inbox.messageId} exists without a matching transaction`,
            );
          }
          await repos.inbox.insert(
            InboxMessage.receive({
              consumerName: command.inbox.consumerName,
              messageId: command.inbox.messageId,
              payloadHash: command.inbox.payloadHash,
              receivedAt: now,
            }),
          );
        }

        // Checagem de idempotência sob o lock da wallet.
        const prior =
          (await repos.transactions.findByIdempotencyKey(command.idempotencyKey)) ??
          (await repos.transactions.findByProviderAndExternalId(
            command.providerId,
            command.externalTransactionId,
          ));
        if (prior) {
          if (!prior.matchesPayload(payloadHash)) {
            throw new IdempotencyConflictError(command.idempotencyKey);
          }
          return replayResult(prior);
        }

        const wallet = await repos.wallets.findById(command.walletId);
        if (!wallet) {
          throw new WalletNotFoundError(command.walletId); // não dá para persistir (FK)
        }

        let tx: WagerTransaction;
        try {
          tx = WagerTransaction.create({
            id: this.ids.next(),
            providerId: command.providerId,
            externalTransactionId: command.externalTransactionId,
            idempotencyKey: command.idempotencyKey,
            payloadHash,
            walletId: command.walletId,
            playerId: command.playerId,
            roundId: command.roundId,
            gameId: command.gameId,
            kind: command.kind,
            money,
            referenceExternalTransactionId: command.referenceExternalTransactionId,
            createdAt: now,
          });
        } catch (err) {
          if (err instanceof ReferenceRequiredError) {
            throw new ValidationError(err.message, FailureCode.MissingReference);
          }
          if (err instanceof DomainError) throw new ValidationError(err.message);
          throw err;
        }

        // Uma violação de unicidade aqui significaria que um duplicado escapou
        // das pré-checagens apesar do lock da wallet — deixa propagar; o retry
        // vai bater na pré-checagem e replicar.
        await repos.transactions.insert(tx);

        // ---- Reversão: resolve a referência (README itens 7 e 7.1) --------
        let reference: WagerTransaction | undefined;
        if (tx.requiresReference()) {
          const found = await repos.transactions.findByProviderAndExternalId(
            tx.providerId,
            tx.referenceExternalTransactionId as string,
          );

          if (!found || !found.isProcessed()) {
            tx.markPendingReference(now);
            await repos.transactions.save(tx);
            await repos.outbox.insert(
              OutboxMessage.enqueue(
                WagerTransactionPendingReference.from(tx, tx.referenceAttempts, eventContext(ctx)),
              ),
            );
            return {
              transactionId: tx.id,
              status: tx.status,
              idempotentReplay: false,
            };
          }

          const mismatch = validateReferenceMatch(tx, found);
          if (mismatch) {
            await rejectTransaction(repos, wallet, tx, mismatch, ctx);
            return persistedResult(tx, wallet.balance);
          }

          const existingReversal = await repos.transactions.findActiveReversalOf(
            found.id,
            tx.kind,
          );
          if (existingReversal && existingReversal.id !== tx.id) {
            await rejectTransaction(repos, wallet, tx, FailureCode.AlreadyReversed, ctx);
            return persistedResult(tx, wallet.balance);
          }

          reference = found;
        }

        // ---- Aplica ----------------------------------------------------------
        try {
          const events = await applyAcceptedTransaction(repos, wallet, tx, reference, ctx);
          await repos.outbox.insertMany(events.map((e) => OutboxMessage.enqueue(e)));
          return persistedResult(tx, wallet.balance);
        } catch (err) {
          const code = toFailureCode(err);
          if (!code) throw err;
          await rejectTransaction(repos, wallet, tx, code, ctx);
          return persistedResult(tx, wallet.balance);
        }
      },
    );
  }
}

function persistedResult(tx: WagerTransaction, balance: Money): ProcessWagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: balance.toJSON(),
    idempotentReplay: false,
    failureCode: tx.failureCode,
  };
}

function replayResult(tx: WagerTransaction): ProcessWagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.observedBalance?.toJSON(),
    idempotentReplay: true,
    failureCode: tx.failureCode,
  };
}
