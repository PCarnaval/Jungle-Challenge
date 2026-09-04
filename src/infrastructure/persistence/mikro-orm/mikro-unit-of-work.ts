import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  LockMode,
  MikroORM,
} from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";

import {
  TransientInfrastructureError,
  UniqueConstraintError,
  type RunOptions,
  type TransactionalRepositories,
  type UnitOfWork,
} from "../../../application/ports/unit-of-work.port";
import { WalletEntity } from "./entities";
import {
  ConcurrentModificationError,
  MikroInboxRepository,
  MikroLedgerRepository,
  MikroOutboxRepository,
  MikroWagerTransactionRepository,
  MikroWalletRepository,
} from "./repositories";

/**
 * O boundary atômico, apoiado no MikroORM. Cada `run` faz fork de um
 * EntityManager dedicado e abre uma transação SQL; quando `lockWallet` está
 * setado, a linha da wallet é tomada `FOR UPDATE` antes de `work` executar, que
 * é o ponto de serialização por wallet (README item 8).
 */
export class MikroUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    /** Chamado sempre que um conflito de deadlock / lost update é normalizado para transitório. */
    private readonly onLockConflict?: () => void,
    /** Chamado com o tempo (segundos) gasto esperando o `FOR UPDATE` da wallet. */
    private readonly onLockWait?: (seconds: number) => void,
  ) {}

  async run<T>(
    options: RunOptions,
    work: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    const em = this.orm.em.fork() as EntityManager;

    try {
      // O callback recebe o EM com escopo de transação — toda leitura/escrita e
      // o lock FOR UPDATE devem passar por ele, não pelo fork externo.
      return await em.transactional(async (txEm) => {
        const scoped = txEm as EntityManager;

        if (options.lockWallet) {
          const waitStartedAt = performance.now();
          await scoped.findOne(
            WalletEntity,
            { id: options.lockWallet },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );
          this.onLockWait?.((performance.now() - waitStartedAt) / 1000);
        }

        const repos: TransactionalRepositories = {
          wallets: new MikroWalletRepository(scoped),
          transactions: new MikroWagerTransactionRepository(scoped),
          ledger: new MikroLedgerRepository(scoped),
          inbox: new MikroInboxRepository(scoped),
          outbox: new MikroOutboxRepository(scoped),
        };

        return work(repos);
      });
    } catch (err) {
      if (
        err instanceof ConcurrentModificationError ||
        err instanceof DeadlockException ||
        err instanceof LockWaitTimeoutException
      ) {
        this.onLockConflict?.();
      }
      throw normalizeError(err);
    }
  }
}

function normalizeError(err: unknown): unknown {
  // Os nossos erros tipados passam direto — quem decide é o use case.
  if (err instanceof UniqueConstraintError || err instanceof TransientInfrastructureError) {
    return err;
  }
  if (
    err instanceof DeadlockException ||
    err instanceof LockWaitTimeoutException ||
    err instanceof ConnectionException ||
    err instanceof ConcurrentModificationError ||
    isConnectivityError(err)
  ) {
    return new TransientInfrastructureError(`Retryable database failure: ${(err as Error).message}`, err);
  }
  return err;
}

const CONNECTIVITY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);
const CONNECTIVITY_MESSAGE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|Connection terminated|connection closed|server closed the connection|timeout expired|too many clients/i;

/**
 * O Postgres inacessível chega como um `AggregateError` cru do `net` (ou um erro
 * do driver com `code`), que o MikroORM não embrulha num `ConnectionException`.
 * Sem isto, "banco fora" viraria 500 em vez do 503 retryable que o item 9 pede.
 * Varre a cadeia `cause` / `AggregateError.errors`.
 */
export function isConnectivityError(err: unknown, seen = new Set<unknown>()): boolean {
  if (!err || typeof err !== "object" || seen.has(err)) return false;
  seen.add(err);
  const e = err as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown };
  if (typeof e.code === "string" && CONNECTIVITY_CODES.has(e.code)) return true;
  if (typeof e.message === "string" && CONNECTIVITY_MESSAGE.test(e.message)) return true;
  if (Array.isArray(e.errors) && e.errors.some((inner) => isConnectivityError(inner, seen))) {
    return true;
  }
  return isConnectivityError(e.cause, seen);
}
