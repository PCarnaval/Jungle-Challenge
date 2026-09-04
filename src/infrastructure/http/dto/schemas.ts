import { z } from "zod";

export const moneySchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
});

export const createWalletSchema = z.object({
  walletId: z.string().min(1).optional(),
  playerId: z.string().min(1),
  initialBalance: moneySchema,
});
export type CreateWalletBody = z.infer<typeof createWalletSchema>;

export const submitTransactionSchema = z.object({
  providerId: z.string().min(1),
  externalTransactionId: z.string().min(1),
  playerId: z.string().min(1),
  walletId: z.string().min(1),
  roundId: z.string().min(1),
  gameId: z.string().min(1),
  // OPENING é interno — não aceito aqui.
  kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
  money: moneySchema,
  referenceExternalTransactionId: z.string().min(1).optional(),
});
export type SubmitTransactionBody = z.infer<typeof submitTransactionSchema>;

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;
