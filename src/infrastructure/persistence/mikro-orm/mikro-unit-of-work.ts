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
          await scoped.findOne(
            WalletEntity,
            { id: options.lockWallet },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );
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
    err instanceof ConcurrentModificationError
  ) {
    return new TransientInfrastructureError(`Retryable database failure: ${(err as Error).message}`, err);
  }
  return err;
}
