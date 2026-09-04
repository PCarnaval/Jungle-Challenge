import { z } from "zod";

/** Envelope de uma mensagem `WagerTransactionRequested` de entrada (README item 10). */
export const wagerMessageSchema = z.object({
  messageId: z.string().min(1),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string(),
  data: z.object({
    providerId: z.string().min(1),
    externalTransactionId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    playerId: z.string().min(1),
    walletId: z.string().min(1),
    roundId: z.string().min(1),
    gameId: z.string().min(1),
    kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
    money: z.object({ amount: z.string().min(1), currency: z.string().min(1) }),
    referenceExternalTransactionId: z.string().min(1).optional(),
  }),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
