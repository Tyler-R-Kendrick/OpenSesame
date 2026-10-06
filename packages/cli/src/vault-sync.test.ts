/**
 * `opensesame-id vault sync` (ADR 0144): two state directories stand in for
 * two machines, one in-memory drive for the daemon. A second machine is set
 * up from the drive with a code, later passes need none, and changes travel
 * both ways — and nothing printed names an item or a value.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveTransport } from "@opensesame/app-core/lib/tailnet-sync/engine.js";
import { formatPairingCode } from "@opensesame/app-core/lib/tailnet-sync/pairing.js";
import type { DriveSnapshot } from "@opensesame/app-core/lib/tailnet-sync/snapshot.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "./parse.js";
import { runCli } from "./run.js";
import { releaseVaultKv } from "./vault-kv.js";

const PASSWORD = "correct horse battery staple";
const CODE = formatPairingCode({
  url: "https://desk.tail4c2e.ts.net",
  slot: "5b1c2d3e-0f4a-4b6c-8d9e-0a1b2c3d4e5f",
  key: "Qm9ndXMtZXZpZGVuY2Uta2V5LW5vdC1hLXJlYWwtb25l",
  label: "Desk",
});

/** The daemon's compare-and-set slot, in memory. */
type MemoryDrive = {
  generation: number;
  snapshot: DriveSnapshot | null;
  transport: DriveTransport;
};

function memoryDrive(): MemoryDrive {
  const drive: MemoryDrive = {
    generation: 0,
    snapshot: null,
    transport: {
      read: async () => {
        return {
          generation: drive.generation,
          snapshot: drive.snapshot ? structuredClone(drive.snapshot) : null,
        };
      },
      write: async (_pairing, expected, snapshot) => {
        if (expected !== drive.generation)
          return { ok: false, generation: drive.generation };
        drive.generation += 1;
        drive.snapshot = structuredClone(snapshot);
        return { ok: true, generation: drive.generation };
      },
    },
  };
  return drive;
}

const password = async () => PASSWORD;

async function run(
  argv: string[],
  stateDir: string,
  transport: DriveTransport,
) {
  let out = "";
  let err = "";
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
  try {
    const code = await runCli(argv, {
      stateDir,
      readPassword: password,
      transport,
    });
    await releaseVaultKv();
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe("opensesame-id vault sync", () => {
  let laptop = "";
  let server = "";

  beforeEach(async () => {
    laptop = await mkdtemp(join(tmpdir(), "os-sync-laptop-"));
    server = await mkdtemp(join(tmpdir(), "os-sync-server-"));
  });

  afterEach(async () => {
    await releaseVaultKv();
    await rm(laptop, { recursive: true, force: true });
    await rm(server, { recursive: true, force: true });
  });

  it("parses a code, and no code", () => {
    expect(parseArgs(["vault", "sync", "--pair", CODE])).toMatchObject({
      name: "vault-sync",
      code: CODE,
    });
    expect(parseArgs(["vault", "sync"])).toMatchObject({ name: "vault-sync" });
    expect(() => parseArgs(["vault", "sync", "extra"])).toThrow(
      "vault sync does not take extra",
    );
  });

  // Eleven runs, each deriving the vault key from the password: as
  // vault-items.test.ts, the KDF needs room on a loaded CI runner.
  it(
    "sets a second machine up, then keeps both in step",
    {
      timeout: 60_000,
    },
    async () => {
      const drive = memoryDrive();
      const t = drive.transport;
      await run(["vault", "new", "note", "--name", "bank"], laptop, t);

      const first = await run(["vault", "sync", "--pair", CODE], laptop, t);
      expect(first.code).toBe(0);
      expect(first.out).toContain("sent changes");
      expect(drive.generation).toBe(1);

      const adopted = await run(["vault", "sync", "--pair", CODE], server, t);
      expect(adopted.out).toContain("set up from the drive");
      expect((await run(["vault", "list"], server, t)).out).toContain("bank");

      // The code was kept: no --pair from now on.
      await run(
        ["vault", "new", "note", "--name", "from the server"],
        server,
        t,
      );
      expect((await run(["vault", "sync"], server, t)).out).toContain(
        "sent changes",
      );
      expect((await run(["vault", "sync"], laptop, t)).out).toContain(
        "took in changes",
      );
      const listed = (await run(["vault", "list"], laptop, t)).out;
      expect(listed).toContain("bank");
      expect(listed).toContain("from the server");

      // Settled, and silent about contents.
      const settled = await run(["vault", "sync"], laptop, t);
      expect(settled.out).toContain("in step");
      expect(settled.out).not.toContain("bank");
    },
  );

  it("asks for a code where there is no vault and no pairing", async () => {
    const drive = memoryDrive();
    const result = await run(["vault", "sync"], server, drive.transport);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Pass --pair <code>");
  });

  it("refuses a code that is not one", async () => {
    const drive = memoryDrive();
    const result = await run(
      ["vault", "sync", "--pair", "not-a-code"],
      laptop,
      drive.transport,
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("not a drive pairing code");
  });
});
