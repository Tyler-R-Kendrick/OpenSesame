import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as activityLog from "@opensesame/app-core/lib/activity-log.js";
import { lockManager } from "@opensesame/app-core/ports.js";
import type { VaultItem } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "./parse.js";
import { runCli } from "./run.js";
import { releaseVaultKv } from "./vault-kv.js";

interface ItemRun {
  readPassword?: (prompt: string) => Promise<string>;
  writeClipboard?: (text: string) => Promise<void>;
  createShare?: (input: {
    name: string;
    payload: { kind: "text"; name: string; text: string };
  }) => Promise<{ link: string; userCode: string; record: VaultItem }>;
}

const PASSWORD = "correct horse battery staple";
const CANARY = "canary-secret-value-9f3a";
const ROTATED = "canary-secret-value-rotated";

function prompts(values: string[]) {
  return async () => {
    const next = values.shift();
    if (next === undefined) throw new Error("unexpected prompt");
    return next;
  };
}

async function run(argv: string[], stateDir: string, extra: ItemRun = {}) {
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
    const code = await runCli(argv, { stateDir, ...extra });
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

async function removeVaultFixture(directory: string) {
  await releaseVaultKv();
  await rm(directory, { recursive: true, force: true });
}

describe("opensesame-id vault item commands", () => {
  let stateDir = "";

  afterEach(async () => {
    await releaseVaultKv();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  it("parses edit as set and refuses an unknown kind", () => {
    expect(parseArgs(["vault", "edit", "Deploy", "--name", "Next"]).name).toBe(
      "vault-set",
    );
    expect(() => parseArgs(["vault", "new", "drop", "--name", "x"])).toThrow(
      /account, secret, note, or card/,
    );
  });

  it("accepts the legacy login kind as an account", () => {
    for (const word of ["login", "account"]) {
      expect(parseArgs(["vault", "new", word, "--name", "Mail"])).toMatchObject(
        { name: "vault-new", kind: "account" },
      );
    }
  });

  // Five KDFs; the 5s default loses on a loaded runner.
  it(
    "logs a generated secret, an update, a copy, and a share without the value",
    { timeout: 60_000 },
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), "os-vault-cli-"));
      const created = await run(
        ["vault", "new", "secret", "--name", "Deploy key"],
        stateDir,
        { readPassword: prompts([PASSWORD, PASSWORD, CANARY]) },
      );
      expect(created.code).toBe(0);
      expect(created.out).toContain("Created secret Deploy key.");
      expect(created.out).not.toContain(CANARY);

      const listed = await run(["vault", "list"], stateDir, {
        readPassword: prompts([PASSWORD]),
      });
      expect(listed.code).toBe(0);
      expect(listed.out).toContain("secret\tDeploy key");
      expect(listed.out).not.toContain(CANARY);

      let copied = "";
      const copy = await run(["vault", "copy", "Deploy key"], stateDir, {
        readPassword: prompts([PASSWORD]),
        writeClipboard: async (text) => {
          copied = text;
        },
      });
      expect(copy.code).toBe(0);
      expect(copy.out).toContain("Copied.");
      expect(copy.out).not.toContain(CANARY);
      expect(copied).toBe(CANARY);

      const updated = await run(
        ["vault", "edit", "Deploy key", "--name", "Deployed", "--secret"],
        stateDir,
        { readPassword: prompts([PASSWORD, ROTATED]) },
      );
      expect(updated.code).toBe(0);
      expect(updated.out).toContain("Updated Deployed.");
      expect(updated.out).not.toContain(ROTATED);

      const shared = await run(["vault", "share", "Deployed"], stateDir, {
        readPassword: prompts([PASSWORD]),
        createShare: async (input) => {
          expect(input.payload.text).toBe(ROTATED);
          const { createItem } = await import("@opensesame/vault-core");
          const record = createItem("drop", input.name);
          record.claimId = "claim-1";
          record.bearerToken = "bearer-1";
          record.expiresAt = "2026-10-02T00:00:00.000Z";
          return {
            link: "https://example.test/claim#fragment",
            userCode: "ABCD-EFGH",
            record,
          };
        },
      });
      expect(shared.code).toBe(0);
      expect(shared.out).toContain("https://example.test/claim#fragment");
      expect(shared.out).toContain("ABCD-EFGH");
      expect(shared.out).not.toContain(ROTATED);
    },
  );

  it(
    "creates an account from the legacy login kind and lists it as account",
    { timeout: 60_000 },
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), "os-vault-cli-"));
      const created = await run(
        ["vault", "new", "login", "--name", "Mail", "--username", "alice"],
        stateDir,
        { readPassword: prompts([PASSWORD, PASSWORD, CANARY]) },
      );
      expect(created.code).toBe(0);
      expect(created.out).toContain("Created account Mail.");
      expect(created.out).not.toContain(CANARY);
      const listed = await run(["vault", "list"], stateDir, {
        readPassword: prompts([PASSWORD]),
      });
      expect(listed.out).toContain("account\tMail");
      expect(listed.out).not.toContain(CANARY);
      let copied = "";
      const copy = await run(["vault", "copy", "Mail"], stateDir, {
        readPassword: prompts([PASSWORD]),
        writeClipboard: async (text) => {
          copied = text;
        },
      });
      expect(copy.code).toBe(0);
      expect(copied).toBe(CANARY);
    },
  );

  it(
    "lists --json item names as they were written, even secret-shaped ones",
    { timeout: 60_000 },
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), "os-vault-cli-"));
      const name = "GitHub token: work";
      expect(
        (
          await run(["vault", "new", "secret", "--name", name], stateDir, {
            readPassword: prompts([PASSWORD, PASSWORD, CANARY]),
          })
        ).code,
      ).toBe(0);
      const listed = await run(["vault", "list", "--json"], stateDir, {
        readPassword: prompts([PASSWORD]),
      });
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.out).items[0].name).toBe(name);
      expect(listed.out).not.toContain(CANARY);
    },
  );

  // Two vault creates, an export, and an import. Each one derives a key.
  it(
    "exports ciphertext and imports it into another vault",
    { timeout: 60_000 },
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), "os-vault-cli-"));
      const other = await mkdtemp(join(tmpdir(), "os-vault-cli-"));
      try {
        expect(
          (
            await run(
              ["vault", "new", "secret", "--name", "Deploy key"],
              stateDir,
              { readPassword: prompts([PASSWORD, PASSWORD, CANARY]) },
            )
          ).code,
        ).toBe(0);
        await releaseVaultKv();
        const reopened = await run(["vault", "list"], stateDir, {
          readPassword: prompts([PASSWORD]),
        });
        expect({ code: reopened.code, err: reopened.err }).toEqual({
          code: 0,
          err: "",
        });
        expect(reopened.out).toContain("Deploy key");
        expect(reopened.out).not.toContain(CANARY);
        const files = await readdir(join(stateDir, "origin-files"));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
          const stored = await readFile(
            join(stateDir, "origin-files", file),
            "utf8",
          );
          expect(stored).not.toContain(CANARY);
        }

        const out = join(stateDir, "export.json");
        const exported = await run(
          ["vault", "export", "--out", out],
          stateDir,
          {
            readPassword: prompts([PASSWORD]),
          },
        );
        expect(exported.code).toBe(0);
        const sealed = await readFile(out, "utf8");
        expect(sealed).not.toContain(CANARY);

        expect(
          (
            await run(["vault", "new", "note", "--name", "Scratch"], other, {
              readPassword: prompts([PASSWORD, PASSWORD, "note body"]),
            })
          ).code,
        ).toBe(0);
        const imported = await run(["vault", "import", out], other, {
          readPassword: prompts([PASSWORD, PASSWORD]),
        });
        expect(imported.code).toBe(0);
        expect(imported.out).toContain("Imported 1 item.");
        const listed = await run(["vault", "list"], other, {
          readPassword: prompts([PASSWORD]),
        });
        expect(listed.out).toContain("Deploy key");
        expect(listed.out).not.toContain(CANARY);
      } finally {
        await removeVaultFixture(other);
      }
    },
  );

  it(
    "joins a real late activity lock before removing its generated vault directory",
    { timeout: 60_000 },
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), "os-vault-cli-"));
      expect(
        (
          await run(
            ["vault", "new", "note", "--name", "Late writer"],
            stateDir,
            {
              readPassword: prompts([PASSWORD, PASSWORD, "Generated note"]),
            },
          )
        ).code,
      ).toBe(0);
      await activityLog.flushActivityLog();
      const locks = lockManager();
      if (!locks) throw new Error("Expected the real Node lock manager.");
      const originalRequest = locks.request.bind(locks);
      let reached = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      type Granted<T> = (lock: Lock | null) => T | PromiseLike<T>;
      async function gatedRequest<T>(
        name: string,
        ...args: [Granted<T>] | [LockOptions, Granted<T>]
      ): Promise<T> {
        if (name === "opensesame:activity-log:personal") {
          reached();
          await blocked;
        }
        return args.length === 1
          ? originalRequest(name, args[0])
          : originalRequest(name, args[0], args[1]);
      }
      const request = vi
        .spyOn(locks, "request")
        .mockImplementation(gatedRequest);
      let teardown: Promise<void> | undefined;
      let flush = () => {};
      try {
        const listed = await run(["vault", "list"], stateDir, {
          readPassword: prompts([PASSWORD]),
        });
        expect(listed.code).toBe(0);
        await started;
        const draining = new Promise<void>((resolve) => {
          flush = resolve;
        });
        const originalFlush = activityLog.flushActivityLog;
        const drain = vi
          .spyOn(activityLog, "flushActivityLog")
          .mockImplementation(async () => {
            flush();
            await originalFlush();
          });
        teardown = removeVaultFixture(stateDir);
        const phase = await Promise.race([
          teardown.then(() => "removed"),
          draining.then(() => "joining"),
        ]);
        release();
        await teardown;
        await releaseVaultKv();
        expect({ phase, recreated: existsSync(stateDir) }).toEqual({
          phase: "joining",
          recreated: false,
        });
        drain.mockRestore();
      } finally {
        release();
        await teardown;
        await releaseVaultKv();
        request.mockRestore();
        vi.restoreAllMocks();
      }
    },
  );
});
