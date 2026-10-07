import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVaultFile } from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import { runCli } from "./run.js";
import { releaseVaultKv } from "./vault-kv.js";
import { readVaultTree } from "./vault-tree.test-support.js";

const PASSWORD = "shared operator password for customer vault test";

async function run(argv: string[], stateDir: string, answers: string[]) {
  let out = "";
  let err = "";
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
  try {
    const code = await runCli(argv, {
      stateDir,
      readPassword: async () => {
        const answer = answers.shift();
        if (answer === undefined) throw new Error("unexpected password prompt");
        return answer;
      },
    });
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    await releaseVaultKv();
  }
}

it("keeps two CLI vault roots separate even under the same master password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-cli-customer-vault-"));
  const customerA = join(directory, "customer-a");
  const customerB = join(directory, "customer-b");
  try {
    for (const [stateDir, name, secret] of [
      [customerA, "Customer A", "customer-a-private-value"],
      [customerB, "Customer B", "customer-b-private-value"],
    ]) {
      const created = await run(
        ["vault", "new", "secret", "--name", name ?? ""],
        stateDir ?? "",
        [PASSWORD, PASSWORD, secret ?? ""],
      );
      expect(created.code).toBe(0);
      expect(created.out + created.err).not.toContain(secret);
      const exported = await run(
        ["vault", "export", "--out", join(stateDir ?? "", "export.json")],
        stateDir ?? "",
        [PASSWORD],
      );
      expect(exported.code).toBe(0);
      expect(await readVaultTree(stateDir ?? "")).not.toContain(secret);
    }
    const exportA = await readFile(join(customerA, "export.json"), "utf8");
    const exportB = await readFile(join(customerB, "export.json"), "utf8");
    const partsA = readVaultFile(exportA);
    const partsB = readVaultFile(exportB);
    expect(partsA.header).not.toEqual(partsB.header);
    const swapped = join(directory, "swapped.json");
    await writeFile(swapped, JSON.stringify({ ...partsA, body: partsB.body }));
    const refused = await run(["vault", "verify", swapped], customerA, [
      PASSWORD,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Not a readable vault file");
    expect(refused.out + refused.err).not.toContain("customer-a-private-value");
    expect(refused.out + refused.err).not.toContain("customer-b-private-value");
    const ownA = await run(
      ["vault", "ls", join(customerA, "export.json")],
      customerA,
      [PASSWORD],
    );
    const ownB = await run(
      ["vault", "ls", join(customerB, "export.json")],
      customerB,
      [PASSWORD],
    );
    expect(ownA.code).toBe(0);
    expect(ownB.code).toBe(0);
    expect(ownA.out).toContain("Customer A");
    expect(ownA.out).not.toContain("Customer B");
    expect(ownB.out).toContain("Customer B");
    expect(ownB.out).not.toContain("Customer A");
  } finally {
    await releaseVaultKv();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
