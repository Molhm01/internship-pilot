import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing for the Internship Pilot account.
 *
 * scrypt is a memory-hard KDF built into Node, so there is no native module to
 * compile and no dependency to keep current. Parameters follow the OWASP
 * minimum for scrypt (N=2^17, r=8, p=1).
 *
 * The plaintext password exists only as an argument here. It is never stored,
 * never logged, never returned by an API, and never placed in a URL. This
 * password protects the Internship Pilot account alone — employer-site
 * credentials never reach this database.
 */

const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
/** scrypt needs roughly 128 * N * r bytes; give it headroom. */
const MAX_MEMORY = 256 * N * R;

export const MINIMUM_PASSWORD_LENGTH = 10;

/** Encoded as `scrypt$N$r$p$salt$hash`, so parameters can change over time. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return ["scrypt", N, R, P, salt.toString("base64"), derived.toString("base64")].join("$");
}

/**
 * Constant-time verification. A malformed stored hash fails closed rather than
 * throwing, so a corrupted row cannot be turned into an authentication bypass.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const cost = Number(rawN);
  const blockSize = Number(rawR);
  const parallelism = Number(rawP);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelism)) {
    return false;
  }
  try {
    const salt = Buffer.from(rawSalt!, "base64");
    const expected = Buffer.from(rawHash!, "base64");
    const derived = await scrypt(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelism,
      maxmem: 256 * cost * blockSize,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Why a password is unacceptable, or null when it is fine. */
export function passwordProblem(password: string, confirmation?: string): string | null {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return "That password is too long.";
  if (confirmation !== undefined && password !== confirmation) {
    return "The two passwords do not match.";
  }
  return null;
}

/** Normalizes an email for storage and comparison, or null when invalid. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 320) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}
