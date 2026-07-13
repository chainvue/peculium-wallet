/**
 * Key-material operations: `export-key`, `backup`, `restore`.
 *
 * export-key has a deliberate ritual (retype the address) — it prints the
 * decrypted WIF, the single most dangerous thing this CLI can do.
 *
 * backup/restore move ONE encrypted archive (scrypt + AES-256-GCM, same
 * parameters as the keystore) containing keystore + policy + ledger + state
 * + audit. The archive passphrase is independent of the keystore
 * passphrase; restore refuses to overwrite existing files.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { readKeystoreFile, unlockKeystore } from "../keystore.js";
import { CliUsageError, parseArgs, type CliContext } from "./context.js";

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ARCHIVE_FILES = ["keystore.json", "policy.json", "ledger.jsonl", "state.json", "audit.jsonl"];

// -------------------------------------------------------------- export-key

export async function cmdExportKey(_argv: readonly string[], ctx: CliContext): Promise<number> {
  const keystore = readKeystoreFile(ctx.dir);
  ctx.err(`You are about to print the DECRYPTED private key for:`);
  ctx.err(`  ${keystore.address}`);
  ctx.err(`Anyone who sees the WIF controls the funds. No undo, no rotation for a`);
  ctx.err(`plain R-address. Close screen shares. Clear your scrollback afterwards.`);
  const typed = await ctx.promptVisible(`Type the address exactly to confirm:`);
  if (typed !== keystore.address) {
    ctx.err(`address mismatch — nothing exported`);
    return 1;
  }
  const passphrase =
    ctx.env["PECULIUM_KEYSTORE_PASSPHRASE"] ??
    (await ctx.promptHidden("Keystore passphrase (input hidden):"));
  const wif = unlockKeystore(keystore, passphrase);
  ctx.out(wif);
  return 0;
}

// ------------------------------------------------------------------ backup

interface ArchivePayload {
  v: 1;
  createdAt: string;
  files: Record<string, string>; // name -> base64
}

function encryptArchive(payload: ArchivePayload, passphrase: string): string {
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${JSON.stringify({
    v: 1,
    kdf: "scrypt",
    kdfParams: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  })}\n`;
}

function decryptArchive(raw: string, passphrase: string): ArchivePayload {
  const envelope = JSON.parse(raw) as {
    v: number;
    kdfParams: { N: number; r: number; p: number; salt: string };
    nonce: string;
    ciphertext: string;
    tag: string;
  };
  if (envelope.v !== 1) {
    throw new CliUsageError(`unsupported backup version ${envelope.v}`);
  }
  const key = scryptSync(passphrase, Buffer.from(envelope.kdfParams.salt, "base64"), 32, {
    N: envelope.kdfParams.N,
    r: envelope.kdfParams.r,
    p: envelope.kdfParams.p,
    maxmem: SCRYPT.maxmem,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new CliUsageError("backup could not be decrypted: wrong passphrase or corrupted file");
  }
  return JSON.parse(plaintext.toString("utf8")) as ArchivePayload;
}

export async function cmdBackup(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { positionals } = parseArgs(argv);
  const target = positionals[0];
  if (target === undefined) {
    throw new CliUsageError("usage: peculium backup <file.pcbk>");
  }
  const files: Record<string, string> = {};
  for (const name of ARCHIVE_FILES) {
    try {
      files[name] = fs.readFileSync(path.join(ctx.dir, name)).toString("base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (files["keystore.json"] === undefined) {
    throw new CliUsageError(`no keystore.json in ${ctx.dir} — nothing worth backing up`);
  }
  const first = await ctx.promptHidden("Choose a passphrase for this backup (min 8 chars):");
  if (first.length < 8) {
    throw new CliUsageError("backup passphrase must be at least 8 characters");
  }
  const second = await ctx.promptHidden("Repeat it:");
  if (first !== second) {
    throw new CliUsageError("passphrases do not match");
  }
  const payload: ArchivePayload = { v: 1, createdAt: ctx.clock().toISOString(), files };
  fs.writeFileSync(target, encryptArchive(payload, first), { mode: 0o600, flag: "wx" });
  ctx.out(`encrypted backup written: ${target} (${Object.keys(files).length} file(s))`);
  ctx.out(`it contains the ENCRYPTED keystore plus policy/ledger/state/audit`);
  return 0;
}

export async function cmdRestore(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { positionals } = parseArgs(argv);
  const source = positionals[0];
  if (source === undefined) {
    throw new CliUsageError("usage: peculium restore <file.pcbk>");
  }
  const raw = fs.readFileSync(source, "utf8");
  const passphrase = await ctx.promptHidden("Backup passphrase (input hidden):");
  const payload = decryptArchive(raw, passphrase);

  fs.mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
  for (const name of Object.keys(payload.files)) {
    const targetPath = path.join(ctx.dir, name);
    if (fs.existsSync(targetPath)) {
      throw new CliUsageError(
        `${targetPath} already exists — refusing to overwrite. Move the current ` +
          `wallet directory aside first.`,
      );
    }
  }
  for (const [name, base64] of Object.entries(payload.files)) {
    fs.writeFileSync(path.join(ctx.dir, name), Buffer.from(base64, "base64"), { mode: 0o600 });
  }
  ctx.out(`restored ${Object.keys(payload.files).length} file(s) into ${ctx.dir}`);
  ctx.out(`(backup was created ${payload.createdAt}; run \`peculium doctor\` next)`);
  return 0;
}
