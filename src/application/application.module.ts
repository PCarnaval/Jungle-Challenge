import { Module } from "@nestjs/common";

import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from "./ports/tokens";
import type { Clock, IdGenerator } from "./ports/system.ports";
import type { UnitOfWork } from "./ports/unit-of-work.port";
import { CreateWallet } from "./use-cases/create-wallet/create-wallet.use-case";
import { ProcessWagerTransaction } from "./use-cases/process-wager-transaction/process-wager-transaction.use-case";
import {
  ReprocessPendingReferences,
  type PendingReferenceConfig,
} from "./use-cases/reprocess-pending-references/reprocess-pending-references.use-case";
import { GetWallet } from "./use-cases/queries/get-wallet.use-case";
import { GetWalletLedger } from "./use-cases/queries/get-wallet-ledger.use-case";
import { GetWagerTransaction } from "./use-cases/queries/get-wager-transaction.use-case";
import { ReconcileWallet } from "./use-cases/reconcile-wallet/reconcile-wallet.use-case";

function pendingReferenceConfig(): PendingReferenceConfig {
  return {
    batchSize: Number(process.env.PENDING_REFERENCE_BATCH_SIZE ?? 50),
    baseBackoffMs: Number(process.env.PENDING_REFERENCE_BASE_BACKOFF_MS ?? 2000),
    maxAttempts: Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 12),
    ttlMs: Number(process.env.PENDING_REFERENCE_TTL_HOURS ?? 24) * 3_600_000,
  };
}

/**
 * Liga os use cases (agnósticos de framework) às suas ports (`UNIT_OF_WORK`,
 * `CLOCK`, `ID_GENERATOR` vêm dos módulos globais Persistence / System). Os use
 * cases são classes simples, construídas aqui por factories.
 */
@Module({
  providers: [
    {
      provide: CreateWallet,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new CreateWallet(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new ProcessWagerTransaction(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: ReprocessPendingReferences,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new ReprocessPendingReferences(uow, clock, ids, pendingReferenceConfig()),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: GetWallet,
      useFactory: (uow: UnitOfWork) => new GetWallet(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GetWalletLedger,
      useFactory: (uow: UnitOfWork) => new GetWalletLedger(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GetWagerTransaction,
      useFactory: (uow: UnitOfWork) => new GetWagerTransaction(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ReconcileWallet,
      useFactory: (uow: UnitOfWork) => new ReconcileWallet(uow),
      inject: [UNIT_OF_WORK],
    },
  ],
  exports: [
    CreateWallet,
    ProcessWagerTransaction,
    ReprocessPendingReferences,
    GetWallet,
    GetWalletLedger,
    GetWagerTransaction,
    ReconcileWallet,
  ],
})
export class ApplicationModule {}
