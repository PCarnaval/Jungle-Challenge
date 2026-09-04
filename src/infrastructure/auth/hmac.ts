import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC request signing, provedor ⇄ plataforma (README item 2).
 *
 * String a assinar (unida por quebras de linha, exatamente estas cinco linhas):
 *
 *     METHOD                          ex.: POST
 *     PATH                            request target com query, ex.: /wallets/abc/ledger?limit=2
 *     PROVIDER_ID                     o valor do header X-Provider-Id
 *     UNIX_TIMESTAMP                  o valor do header X-Timestamp (segundos)
 *     SHA256_HEX(rawBody)            sha-256 hex dos bytes exatos do body ("" quando não há body)
 *
 * `X-Signature: <hmac-sha256 hex da string acima, chaveado pelo segredo compartilhado>`
 */
export interface SignatureParts {
  method: string;
  path: string;
  providerId: string;
  timestamp: string;
  rawBody: Buffer | string;
}

export function canonicalStringToSign(p: SignatureParts): string {
  const body = typeof p.rawBody === "string" ? Buffer.from(p.rawBody, "utf8") : p.rawBody;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return [p.method.toUpperCase(), p.path, p.providerId, p.timestamp, bodyHash].join("\n");
}

export function computeSignature(secret: string, parts: SignatureParts): string {
  return createHmac("sha256", secret).update(canonicalStringToSign(parts), "utf8").digest("hex");
}

export type HmacVerifyReason =
  | "malformed"
  | "stale_timestamp"
  | "bad_signature";

export type HmacVerifyResult = { ok: true } | { ok: false; reason: HmacVerifyReason };

export function verifyHmacSignature(input: {
  parts: SignatureParts;
  signature: string;
  secret: string;
  now: Date;
  toleranceSeconds: number;
}): HmacVerifyResult {
  const { parts, signature, secret, now, toleranceSeconds } = input;

  if (!signature || !/^[0-9a-f]+$/i.test(signature) || signature.length % 2 !== 0) {
    return { ok: false, reason: "malformed" };
  }
  const ts = Number(parts.timestamp);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
    return { ok: false, reason: "malformed" };
  }
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - ts);
  if (skew > toleranceSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = createHmac("sha256", secret)
    .update(canonicalStringToSign(parts), "utf8")
    .digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
