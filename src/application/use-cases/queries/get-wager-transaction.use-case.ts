import type { MoneyProps } from "../../../domain/money/money";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import type { FailureCode } from "../../../domain/wagering/failure-code";
import { TransactionNotFoundError } from "../../application-error";
import type { UnitOfWork } from "../../ports/unit-of-work.port";

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  observedBalance: MoneyProps | null;
  referenceAttempts: number;
  createdAt: string;
  processedAt: string | null;
}

export function toTransactionView(tx: WagerTransaction): WagerTransactionView {
  const s = tx.toState();
  return {
    id: s.id,
    providerId: s.providerId,
    externalTransactionId: s.externalTransactionId,
    walletId: s.walletId,
    playerId: s.playerId,
    roundId: s.roundId,
    gameId: s.gameId,
    kind: s.kind,
    money: s.money,
    status: s.status,
    failureCode: s.failureCode,
    referenceExternalTransactionId: s.referenceExternalTransactionId,
    referenceTransactionId: s.referenceTransactionId,
    observedBalance: s.observedBalance,
    referenceAttempts: s.referenceAttempts,
    createdAt: s.createdAt.toISOString(),
    processedAt: s.processedAt ? s.processedAt.toISOString() : null,
  };
}

export class GetWagerTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.run({ name: "query:transaction-by-id" }, (repos) =>
      repos.transactions.findById(transactionId),
    );
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return toTransactionView(tx);
  }

  async byProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const tx = await this.uow.run({ name: "query:transaction-by-provider" }, (repos) =>
      repos.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
    if (!tx) throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    return toTransactionView(tx);
  }
}
