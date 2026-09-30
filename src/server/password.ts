// Password hashing with scrypt. The app stores and compares hashes only; the
// shared password itself is typed by its owner and never written anywhere.
// (No "server-only" import here so scripts/hash-password.ts can reuse this.)

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Cost used for real passwords: about 32 MB of memory and ~100 ms per check. */
export const STRONG_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
/** Lowest cost a deployed environment accepts. */
export const MIN_DEPLOYED_N = 2 ** 14;

const KEY_LENGTH = 32;
const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{43})$/;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { ...params, maxmem: 256 * params.N * params.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

export function parsePasswordHash(hash: string): ParsedHash | null {
  const match = FORMAT.exec(hash);
  if (!match) return null;
  const params = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  const powerOfTwo = Number.isInteger(Math.log2(params.N));
  if (!powerOfTwo || params.N < 2 ** 10 || params.N > 2 ** 20) return null;
  if (params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16) return null;
  return {
    params,
    salt: Buffer.from(match[4], "base64url"),
    key: Buffer.from(match[5], "base64url"),
  };
}

export async function hashPassword(
  password: string,
  params: ScryptParams = STRONG_PARAMS,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, params);
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}
