import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requiresFreshOwnerAuthentication } from "@opensesame/app-core/lib/decoy-session.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runCli } from "./run.js";
import { releaseVaultKv } from "./vault-kv.js";

async function coldProcess(stateDir: string, mode: string) {
  const outputPath = join(stateDir, `child-${mode}.out`);
  const errorsPath = join(stateDir, `child-${mode}.err`);
  const output = await open(outputPath, "w", 0o600);
  const errors = await open(errorsPath, "w", 0o600);
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test-fixtures/retired-process.ts", stateDir, mode],
      {
        stdio: ["ignore", output.fd, errors.fd],
      },
    );
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect({ code, stderr: await readFile(errorsPath, "utf8") }).toEqual({
      code: 0,
      stderr: expect.any(String),
    });
    return { stdout: await readFile(outputPath, "utf8") };
  } finally {
    await output.close();
    await errors.close();
  }
}
const CURRENT = "correct horse battery staple";
const RETIRED = "retired owner password 7391";
const SECRET = "real-production-secret-49372";
const REAL_NAME = "Production service";
const metadata = z.object({
  traps: z.array(z.object({ id: z.string(), response: z.string() })),
  events: z.array(z.object({ type: z.string() })),
});
const ENROLL = [
  "vault",
  "retired-credentials",
  "enroll",
  "--acknowledge-password-verifier-risk",
];

function passwords(values: string[]) {
  return async () => {
    const next = values.shift();
    if (next === undefined) throw new Error("Unexpected password prompt.");
    return next;
  };
}

async function run(
  argv: string[],
  stateDir: string,
  values?: string[],
  clipboard?: (value: string) => Promise<void>,
) {
  let out = "";
  let err = "";
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((value) => {
      out += String(value);
      return true;
    });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((value) => {
      err += String(value);
      return true;
    });
  try {
    const code = await runCli(argv, {
      stateDir,
      ...(values ? { readPassword: passwords(values) } : undefined),
      ...(clipboard ? { writeClipboard: clipboard } : undefined),
    });
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe("retired passwords across human CLI process restarts", () => {
  let stateDir = "";
  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "os-retired-cli-"));
    const created = await run(
      ["vault", "new", "secret", "--name", REAL_NAME],
      stateDir,
      [CURRENT, CURRENT, SECRET],
    );
    expect({ code: created.code, err: created.err }).toEqual({
      code: 0,
      err: "",
    });
    await releaseVaultKv();
  }, 60_000);
  afterEach(async () => {
    try {
      // A warm test process must prove its original owner before removing
      // that generated vault; a public lock does not clear this obligation.
      if (stateDir && requiresFreshOwnerAuthentication()) {
        const restored = await run(["vault", "list"], stateDir, [CURRENT]);
        expect({ code: restored.code, err: restored.err }).toEqual({
          code: 0,
          err: "",
        });
        expect(requiresFreshOwnerAuthentication()).toBe(false);
      }
    } finally {
      await releaseVaultKv();
      if (stateDir) await rm(stateDir, { recursive: true, force: true });
    }
  });

  it(
    "synthetic replay lists only fabricated data, denies all outward operations, and preserves real access",
    { timeout: 120_000 },
    async () => {
      expect(
        (
          await run([...ENROLL, "--response", "synthetic_decoy"], stateDir, [
            CURRENT,
            RETIRED,
          ])
        ).code,
      ).toBe(0);
      await releaseVaultKv();
      const childSynthetic = await coldProcess(stateDir, "synthetic");
      expect(childSynthetic.stdout).toContain("Example account");
      expect(childSynthetic.stdout).not.toContain(REAL_NAME);
      const childReal = await coldProcess(stateDir, "real");
      expect(childReal.stdout).toContain(REAL_NAME);
      expect(childReal.stdout).not.toContain("Example account");
      const childSyntheticReplay = await coldProcess(stateDir, "synthetic");
      expect(childSyntheticReplay.stdout).toContain("Example account");
      expect(childSyntheticReplay.stdout).not.toContain(REAL_NAME);
      expect(childSyntheticReplay.stdout).not.toContain(SECRET);
      const synthetic = await run(["vault", "list", "--json"], stateDir, [
        RETIRED,
      ]);
      expect({ code: synthetic.code, err: synthetic.err }).toEqual({
        code: 0,
        err: "",
      });
      expect(synthetic.out).toContain("Example account");
      expect(synthetic.out).not.toContain(REAL_NAME);
      expect(synthetic.out).not.toContain(SECRET);
      const clipboard = vi.fn(async (_value: string) => {});
      expect(
        (
          await run(
            ["vault", "copy", "Example account"],
            stateDir,
            [RETIRED],
            clipboard,
          )
        ).code,
      ).toBe(1);
      expect(clipboard).not.toHaveBeenCalled();
      const syntheticWrite = await run(
        ["vault", "new", "secret", "--name", "Synthetic saved secret"],
        stateDir,
        [RETIRED, "decoy-only-input"],
      );
      expect({ code: syntheticWrite.code, err: syntheticWrite.err }).toEqual({
        code: 0,
        err: "",
      });
      for (const command of [
        ["vault", "share", "Example account"],
        ["vault", "export", "--out", join(stateDir, "escaped.json")],
        ["vault", "import", "absent-file"],
        ["vault", "retired-credentials", "status"],
      ])
        expect((await run(command, stateDir, [RETIRED])).code).toBe(1);
      await expect(
        readFile(join(stateDir, "escaped.json"), "utf8"),
      ).rejects.toThrow();
      await releaseVaultKv();
      const real = await run(["vault", "list"], stateDir, [CURRENT]);
      expect(real.code).toBe(0);
      expect(real.out).toContain(REAL_NAME);
      expect(real.out).not.toContain("Example account");
      expect(real.out).not.toContain("Synthetic saved secret");
      let copied = "";
      expect(
        (
          await run(
            ["vault", "copy", REAL_NAME],
            stateDir,
            [CURRENT],
            async (value) => {
              copied = value;
            },
          )
        ).code,
      ).toBe(0);
      expect(copied).toBe(SECRET);
      const status = await run(
        ["vault", "retired-credentials", "status", "--json"],
        stateDir,
        [CURRENT],
      );
      expect(status.code).toBe(0);
      const parsed = metadata.parse(JSON.parse(status.out));
      expect(parsed.traps).toHaveLength(1);
      expect(parsed.events.length).toBeGreaterThan(0);
      for (const secret of [CURRENT, RETIRED, SECRET, "verifier", "salt"])
        expect(status.out).not.toContain(secret);
      expect(
        (
          await run(["vault", "retired-credentials", "clear"], stateDir, [
            CURRENT,
          ])
        ).code,
      ).toBe(0);
      const cleared = await run(
        ["vault", "retired-credentials", "status", "--json"],
        stateDir,
        [CURRENT],
      );
      expect(metadata.parse(JSON.parse(cleared.out)).events).toHaveLength(0);
      const id = parsed.traps[0]?.id;
      if (!id) throw new Error("Expected an enrolled trap.");
      expect(
        (
          await run(["vault", "retired-credentials", "remove", id], stateDir, [
            CURRENT,
          ])
        ).code,
      ).toBe(0);
      await releaseVaultKv();
      const removed = await run(
        ["vault", "retired-credentials", "status", "--json"],
        stateDir,
        [CURRENT],
      );
      expect(metadata.parse(JSON.parse(removed.out)).traps).toHaveLength(0);
    },
  );

  it(
    "rejects replay by default without disabling owner commands",
    { timeout: 60_000 },
    async () => {
      expect((await run(ENROLL, stateDir, [CURRENT, RETIRED])).code).toBe(0);
      await releaseVaultKv();
      expect((await run(["vault", "list"], stateDir, [RETIRED])).code).toBe(1);
      expect((await run(["vault", "list"], stateDir, [CURRENT])).code).toBe(0);
      expect((await run(ENROLL, stateDir, [CURRENT, CURRENT])).code).toBe(1);
    },
  );

  it(
    "denies unauthenticated management without changing trap records",
    { timeout: 60_000 },
    async () => {
      expect((await run(ENROLL, stateDir, [CURRENT, RETIRED])).code).toBe(0);
      const before = await run(
        ["vault", "retired-credentials", "status", "--json"],
        stateDir,
        [CURRENT],
      );
      const traps = metadata.parse(JSON.parse(before.out)).traps;
      const id = traps[0]?.id;
      if (!id) throw new Error("Expected a trap id.");
      const human = await run(
        ["vault", "retired-credentials", "status"],
        stateDir,
        [CURRENT],
      );
      expect(human.out).toContain(`${id}: Record and reject`);
      for (const command of [
        ["vault", "retired-credentials", "remove", id],
        ["vault", "retired-credentials", "clear"],
        [...ENROLL],
      ]) {
        const denied = await run(command, stateDir, [
          "incorrect owner password",
        ]);
        expect(denied.code).toBe(1);
        expect(denied.out).toBe("");
        expect(denied.err).not.toContain("incorrect owner password");
      }
      await releaseVaultKv();
      const after = await run(
        ["vault", "retired-credentials", "status", "--json"],
        stateDir,
        [CURRENT],
      );
      expect(metadata.parse(JSON.parse(after.out)).traps).toEqual(traps);
    },
  );

  it("requires a controlling terminal by default and never accepts a password argument", async () => {
    const wasTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    try {
      const outcome = await run(
        ["vault", "retired-credentials", "status"],
        stateDir,
      );
      expect(outcome.code).toBe(1);
      expect(outcome.err).toContain("terminal only");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: wasTty,
        configurable: true,
      });
    }
    expect((await run([...ENROLL, "--password", SECRET], stateDir)).code).toBe(
      1,
    );
  });
});
