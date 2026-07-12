import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createKeystoreFile,
  KeystoreError,
  KeystoreExistsError,
  KeystoreMissingError,
  KeystoreUnlockError,
  readKeystoreFile,
  unlockKeystore,
  writeKeystoreFile,
} from "../src/keystore.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-keystore-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

const WIF = "UusoQWsobQKUkezgBJa22D9G4t9Avo6k8wD5UUxmmfAEoTN8bawc";
const ADDRESS = "RQr2cUkF46n7y8WRzDkd1iV9gHusSSQuzX";
const PASSPHRASE = "correct horse battery staple";
const CLOCK = () => new Date("2026-07-12T12:00:00.000Z");

function makeFile() {
  return createKeystoreFile({
    wif: WIF,
    passphrase: PASSPHRASE,
    address: ADDRESS,
    addressMode: "verusid",
    clock: CLOCK,
  });
}

describe("keystore crypto", () => {
  it("round-trips the WIF through encrypt and unlock", () => {
    const file = makeFile();
    expect(unlockKeystore(file, PASSPHRASE)).toBe(WIF);
    expect(file.address).toBe(ADDRESS); // plaintext, for passphrase-free reads
    expect(file.createdAt).toBe("2026-07-12T12:00:00.000Z");
  });

  it("never stores the WIF in the clear", () => {
    const serialized = JSON.stringify(makeFile());
    expect(serialized).not.toContain(WIF);
  });

  it("fresh salt and nonce per keystore — identical inputs share no secrets", () => {
    const a = makeFile();
    const b = makeFile();
    expect(a.kdfParams.salt).not.toBe(b.kdfParams.salt);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("a wrong passphrase throws KeystoreUnlockError", () => {
    expect(() => unlockKeystore(makeFile(), "not the passphrase")).toThrow(KeystoreUnlockError);
  });

  it("a tampered ciphertext or tag throws KeystoreUnlockError (GCM auth)", () => {
    const file = makeFile();
    const flip = (b64: string): string => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString("base64");
    };
    expect(() => unlockKeystore({ ...file, ciphertext: flip(file.ciphertext) }, PASSPHRASE)).toThrow(
      KeystoreUnlockError,
    );
    expect(() => unlockKeystore({ ...file, tag: flip(file.tag) }, PASSPHRASE)).toThrow(
      KeystoreUnlockError,
    );
  });

  it("refuses a weak passphrase and an empty key at create", () => {
    expect(() =>
      createKeystoreFile({ wif: WIF, passphrase: "short", address: ADDRESS, addressMode: "verusid" }),
    ).toThrow(/at least 8/);
    expect(() =>
      createKeystoreFile({ wif: "", passphrase: PASSPHRASE, address: ADDRESS, addressMode: "verusid" }),
    ).toThrow(KeystoreError);
  });
});

describe("keystore IO", () => {
  it("round-trips through write and read, file mode 0600", () => {
    const dir = tempDir();
    const file = makeFile();
    writeKeystoreFile(dir, file);
    expect(readKeystoreFile(dir)).toEqual(file);
    const mode = fs.statSync(path.join(dir, "keystore.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("NEVER overwrites an existing keystore", () => {
    const dir = tempDir();
    writeKeystoreFile(dir, makeFile());
    expect(() => writeKeystoreFile(dir, makeFile())).toThrow(KeystoreExistsError);
  });

  it("a missing keystore throws the typed error pointing at init", () => {
    expect(() => readKeystoreFile(tempDir())).toThrow(KeystoreMissingError);
  });

  it("invalid JSON and unknown keys refuse (strict schema)", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "keystore.json"), "{ torn", { mode: 0o600 });
    expect(() => readKeystoreFile(dir)).toThrow(KeystoreError);

    const dir2 = tempDir();
    const withExtra = { ...makeFile(), exportedTo: "attacker" };
    fs.writeFileSync(path.join(dir2, "keystore.json"), JSON.stringify(withExtra), { mode: 0o600 });
    expect(() => readKeystoreFile(dir2)).toThrow(KeystoreError);
  });

  it("rejects downgraded kdf params (literal N/r/p in the schema)", () => {
    const dir = tempDir();
    const file = makeFile();
    const weakened = {
      ...file,
      kdfParams: { ...file.kdfParams, N: 1024 },
    };
    fs.writeFileSync(path.join(dir, "keystore.json"), JSON.stringify(weakened), { mode: 0o600 });
    expect(() => readKeystoreFile(dir)).toThrow(KeystoreError);
  });
});
