/**
 * The encrypted keystore — where the spending key lives at rest.
 *
 * Lite architecture (DESIGN.md §3, superseded section): the WIF is
 * encrypted with AES-256-GCM under a scrypt-derived key and stored as
 * `keystore.json` (0600) in the config dir. The unlock passphrase arrives
 * via env (`PECULIUM_KEYSTORE_PASSPHRASE` — set in the MCP host config);
 * the KEY ITSELF is never in env, never in policy, never in any MCP tool.
 *
 * Honest limits, stated plainly: encryption at rest protects backups and
 * other users, NOT same-user malware — anything that can read the env and
 * the file can decrypt. And JavaScript cannot reliably zeroize strings, so
 * the decrypted WIF lives in process memory while the wallet runs. Both
 * are accepted v1 trade-offs (RISKS.md "key in process"); the v2 signer
 * daemon is the real fix.
 *
 * The `address` is stored in PLAINTEXT deliberately: it is public
 * information, and read-only tools (balance, receive address) must work
 * without ever touching the passphrase.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { PeculiumError } from "./errors.js";
import type { AddressMode } from "./limits.js";

const KEYSTORE_FILE = "keystore.json";

/** scrypt cost parameters: N=2^15, r=8 → 32 MiB, interactive-grade. */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SALT_BYTES = 32;

/** Creating a keystore demands a real passphrase; unlocking takes anything. */
const MIN_PASSPHRASE_LENGTH = 8;

export class KeystoreError extends PeculiumError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "KeystoreError";
  }
}

/** Wrong passphrase OR a tampered file — GCM cannot distinguish the two. */
export class KeystoreUnlockError extends KeystoreError {
  constructor() {
    super(
      "keystore-unlock",
      "keystore could not be decrypted: wrong passphrase or tampered file.",
    );
    this.name = "KeystoreUnlockError";
  }
}

export class KeystoreMissingError extends KeystoreError {
  constructor(dir: string) {
    super("keystore-missing", `no keystore at ${dir} — run \`peculium init\` first.`);
    this.name = "KeystoreMissingError";
  }
}

export class KeystoreExistsError extends KeystoreError {
  constructor(filePath: string) {
    super(
      "keystore-exists",
      `${filePath} already exists; refusing to overwrite key material. ` +
        `Back it up and remove it explicitly if you really mean to replace it.`,
    );
    this.name = "KeystoreExistsError";
  }
}

const base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64");

/** The strict on-disk shape. Unknown keys refuse — this file guards money. */
export const keystoreFileSchema = z.strictObject({
  v: z.literal(1),
  address: z.string().min(1),
  addressMode: z.enum(["starter-r-address", "verusid"]),
  kdf: z.literal("scrypt"),
  kdfParams: z.strictObject({
    N: z.literal(SCRYPT_N),
    r: z.literal(SCRYPT_R),
    p: z.literal(SCRYPT_P),
    salt: base64Schema,
  }),
  cipher: z.literal("aes-256-gcm"),
  nonce: base64Schema,
  ciphertext: base64Schema,
  tag: base64Schema,
  createdAt: z.iso.datetime({ offset: true }),
});

export type KeystoreFile = z.infer<typeof keystoreFileSchema>;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Encrypt a WIF under a passphrase into the on-disk keystore shape. Fresh
 * random salt and nonce per call — two keystores from the same inputs
 * never share bytes.
 */
export function createKeystoreFile(params: {
  wif: string;
  passphrase: string;
  address: string;
  addressMode: AddressMode;
  clock?: () => Date;
}): KeystoreFile {
  if (params.wif.length === 0) {
    throw new KeystoreError("keystore-invalid", "refusing to encrypt an empty key.");
  }
  if (params.passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new KeystoreError(
      "keystore-weak-passphrase",
      `the keystore passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    );
  }
  const clock = params.clock ?? (() => new Date());
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = deriveKey(params.passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(params.wif, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    address: params.address,
    addressMode: params.addressMode,
    kdf: "scrypt",
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
    createdAt: clock().toISOString(),
  };
}

/**
 * Decrypt the WIF. GCM authenticates before it decrypts, so a wrong
 * passphrase and a tampered file both surface as the same
 * {@link KeystoreUnlockError} — deliberately indistinguishable.
 */
export function unlockKeystore(file: KeystoreFile, passphrase: string): string {
  const salt = Buffer.from(file.kdfParams.salt, "base64");
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new KeystoreUnlockError();
  }
}

/** Read and strictly validate `keystore.json`; missing file is typed. */
export function readKeystoreFile(dir: string): KeystoreFile {
  const filePath = path.join(dir, KEYSTORE_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KeystoreMissingError(dir);
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new KeystoreError("keystore-invalid", `keystore.json is not valid JSON: ${detail}`);
  }
  const result = keystoreFileSchema.safeParse(json);
  if (!result.success) {
    throw new KeystoreError(
      "keystore-invalid",
      "keystore.json does not match the expected shape (tampered or from a newer version?).",
    );
  }
  return result.data;
}

/**
 * Write `keystore.json` (0600) with "wx" — an existing keystore is NEVER
 * silently overwritten; losing an old key can mean losing funds.
 */
export function writeKeystoreFile(dir: string, file: KeystoreFile): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, KEYSTORE_FILE);
  const payload = `${JSON.stringify(file, null, 2)}\n`;
  let fd: number;
  try {
    fd = fs.openSync(filePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new KeystoreExistsError(filePath);
    }
    throw error;
  }
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
