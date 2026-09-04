import type { MoneyProps } from "../../../domain/money/money";
import { WalletNotFoundError } from "../../application-error";
import type { UnitOfWork } from "../../ports/unit-of-work.port";

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run({ name: "query:get-wallet" }, (repos) =>
      repos.wallets.findById(walletId),
    );
    if (!wallet) throw new WalletNotFoundError(walletId);

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}
