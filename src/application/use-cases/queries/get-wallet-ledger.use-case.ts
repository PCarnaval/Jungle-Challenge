import type { MoneyProps } from "../../../domain/money/money";
import type { LedgerDirection } from "../../../domain/wallet/wallet-ledger-entry";
import { WalletNotFoundError } from "../../application-error";
import type { UnitOfWork } from "../../ports/unit-of-work.port";

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export class GetWalletLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string, cursor: string | null, limit: number): Promise<LedgerPageView> {
    return this.uow.run({ name: "query:wallet-ledger" }, async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const page = await repos.ledger.listByWallet(walletId, cursor, limit);
      return {
        entries: page.entries.map((e) => ({
          id: e.id,
          transactionId: e.transactionId,
          direction: e.direction,
          money: e.money.toJSON(),
          balanceBefore: e.balanceBefore.toJSON(),
          balanceAfter: e.balanceAfter.toJSON(),
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }
}
