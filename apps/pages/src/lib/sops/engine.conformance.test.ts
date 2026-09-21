/** @vitest-environment node */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as age from "age-encryption";
import { describe, expect, it } from "vitest";
import { decryptSopsDocument, encryptSopsDocument } from "./engine.js";

const exec = promisify(execFile);
const bin = process.env.SOPS_BIN;

describe.skipIf(!bin)("sops v3.13.3 oracle", () => {
  it("browser ciphertext decrypts with upstream sops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sops-browser-"));
    try {
      const identity = await age.generateX25519Identity();
      const recipient = await age.identityToRecipient(identity);
      const ciphertext = await encryptSopsDocument({
        format: "yaml",
        plaintext: "hello: world\ncount: 2\n",
        recipients: [recipient],
        now: new Date("2026-09-21T12:00:00Z"),
      });
      const file = join(dir, "doc.yaml");
      const keyFile = join(dir, "key.txt");
      await writeFile(file, ciphertext);
      await writeFile(keyFile, `${identity}\n`, { mode: 0o600 });
      const opened = await exec(bin ?? "", ["--decrypt", file], {
        env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      expect(opened.stdout).toMatch(/hello: world/);
      expect(opened.stdout).toMatch(/count: 2/);
      const json = await encryptSopsDocument({
        format: "json",
        plaintext: '{"hello":"world","count":2}',
        recipients: [recipient],
        now: new Date("2026-09-21T12:00:00Z"),
      });
      const jsonFile = join(dir, "doc.json");
      await writeFile(jsonFile, json);
      const jsonOpened = await exec(bin ?? "", ["--decrypt", jsonFile], {
        env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      expect(jsonOpened.stdout).toMatch(/"hello": "world"/);
      expect(jsonOpened.stdout).toMatch(/"count": 2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("upstream ciphertext opens in the browser engine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sops-upstream-"));
    try {
      const identity = await age.generateX25519Identity();
      const recipient = await age.identityToRecipient(identity);
      const plain = join(dir, "plain.yaml");
      const keyFile = join(dir, "key.txt");
      await writeFile(plain, "hello: world\ncount: 2\n");
      await writeFile(keyFile, `${identity}\n`, { mode: 0o600 });
      const encrypted = await exec(
        bin ?? "",
        [
          "--encrypt",
          "--age",
          recipient,
          "--input-type",
          "yaml",
          "--output-type",
          "yaml",
          plain,
        ],
        {
          env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile },
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const opened = await decryptSopsDocument({
        format: "yaml",
        ciphertext: encrypted.stdout,
        identity,
      });
      expect(opened).toMatch(/hello: world/);
      expect(opened).toMatch(/count/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
