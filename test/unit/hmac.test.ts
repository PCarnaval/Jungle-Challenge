import { describe, expect, it } from "bun:test";
import {
  canonicalStringToSign,
  computeSignature,
  verifyHmacSignature,
  type SignatureParts,
} from "../../src/infrastructure/auth/hmac";

const SECRET = "a-very-long-random-shared-secret";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

const parts = (over: Partial<SignatureParts> = {}): SignatureParts => ({
  method: "POST",
  path: "/wagering/transactions",
  providerId: "provider-a",
  timestamp: TS,
  rawBody: '{"kind":"BET"}',
  ...over,
});

describe("canonicalStringToSign", () => {
  it("is the five fixed lines in order, body hashed", () => {
    const s = canonicalStringToSign(parts());
    const lines = s.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("POST");
    expect(lines[1]).toBe("/wagering/transactions");
    expect(lines[2]).toBe("provider-a");
    expect(lines[3]).toBe(TS);
    expect(lines[4]).toMatch(/^[0-9a-f]{64}$/); // sha256 em hex do corpo
  });

  it("uppercases the method and hashes an empty body deterministically", () => {
    const a = canonicalStringToSign(parts({ method: "get", rawBody: "" }));
    const b = canonicalStringToSign(parts({ method: "GET", rawBody: Buffer.alloc(0) }));
    expect(a).toBe(b);
  });
});

describe("computeSignature / verifyHmacSignature", () => {
  const verify = (over: Parameters<typeof verifyHmacSignature>[0]) => verifyHmacSignature(over);

  it("accepts a correct signature within the timestamp window", () => {
    const signature = computeSignature(SECRET, parts());
    expect(verify({ parts: parts(), signature, secret: SECRET, now: NOW, toleranceSeconds: 300 })).toEqual({
      ok: true,
    });
  });

  it("rejects a signature made with the wrong secret", () => {
    const signature = computeSignature("wrong-secret", parts());
    expect(
      verify({ parts: parts(), signature, secret: SECRET, now: NOW, toleranceSeconds: 300 }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects when the body was tampered after signing", () => {
    const signature = computeSignature(SECRET, parts({ rawBody: '{"kind":"BET"}' }));
    expect(
      verify({
        parts: parts({ rawBody: '{"kind":"WIN"}' }),
        signature,
        secret: SECRET,
        now: NOW,
        toleranceSeconds: 300,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale or future timestamp beyond tolerance", () => {
    const signature = computeSignature(SECRET, parts());
    const later = new Date(NOW.getTime() + 301_000);
    expect(
      verify({ parts: parts(), signature, secret: SECRET, now: later, toleranceSeconds: 300 }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects malformed signatures and timestamps", () => {
    const good = computeSignature(SECRET, parts());
    for (const bad of ["", "xyz", good + "a" /* odd length */, "zz".repeat(32) /* non-hex */]) {
      expect(
        verify({ parts: parts(), signature: bad, secret: SECRET, now: NOW, toleranceSeconds: 300 }).ok,
      ).toBe(false);
    }
    expect(
      verify({
        parts: parts({ timestamp: "not-a-number" }),
        signature: good,
        secret: SECRET,
        now: NOW,
        toleranceSeconds: 300,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("a shorter-but-hex signature is rejected, not a crash", () => {
    expect(
      verify({ parts: parts(), signature: "abcd", secret: SECRET, now: NOW, toleranceSeconds: 300 }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});
