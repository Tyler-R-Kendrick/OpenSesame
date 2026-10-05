import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JsonObject,
  type JsonValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  openVaultBody,
  readVaultFile,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./run.js";
import { applyKeys } from "./tty-password.js";

type Vector = {
  file: string;
  expect: {
    tomb: string;
    bound: boolean;
    rev: number | null;
    items: { id: string; name: string; kind: string }[];
    concealed?: string[];
  };
};
type Fixture = { password: string; vectors: Record<string, Vector> };

const fixture: Fixture = overlapCast(
  JSON.parse(
    readFileSync(
      new URL("../../../spec/conformance/vault-vectors.json", import.meta.url),
      "utf8",
    ),
  ),
);

let dir = "";
let out = "";
let err = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opensesame-id-vault-"));
  vi.stubEnv("OPENSESAME_STATE_DIR", join(dir, "state"));
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function vectorFile(name: string): Promise<string> {
  const vector = fixture.vectors[name];
  if (!vector) throw new Error(`no vector ${name}`);
  const path = join(dir, `${name}.json`);
  await writeFile(path, vector.file);
  return path;
}

/**
 * The TypeScript readers normalize a legacy `login` to an `account` on open
 * (ADR 0168 §1); the golden vectors keep their `login` bytes untouched, so the
 * listing names the account kind for them.
 */
const normalizedKind = <T extends { kind: string }>(item: T): T => ({
  ...item,
  kind: item.kind === "login" ? "account" : item.kind,
});

/**
 * Closed vocabulary an account body names its methods and generators with
 * (ADR 0168 §2-3). These are field *kinds*, not values: "sphinx" is also a word
 * in an item's own name, which the listing may show. Every secret an account
 * holds (a method's secret, sealed envelope, OPRF key, token, client secret)
 * stays in the scan.
 */
const VOCABULARY = new Set([
  "password",
  "api-key",
  "token",
  "oauth",
  "authenticator",
  "rules",
  "passphrase",
  "sphinx",
  "manual",
  "PBKDF2-SHA256",
]);

const typed = (password: string) => ({
  readPassword: vi.fn(async () => password),
});

/** Every string anywhere in a JSON-serialisable value. */
function stringLeaves(value: JsonValue): string[] {
  const found: string[] = [];
  JSON.parse(JSON.stringify(value), (_key, leaf: JsonValue) => {
    if (isString(leaf)) found.push(leaf);
    return leaf;
  });
  return found;
}

describe("opensesame-id vault verify / ls over the golden vectors", () => {
  it.each(Object.entries(fixture.vectors))(
    "verifies %s",
    async (name, vector) => {
      const code = await runCli(
        ["vault", "verify", await vectorFile(name), "--json"],
        typed(fixture.password),
      );
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        ok: true,
        format: expect.any(String),
        tomb: vector.expect.tomb,
        bound: vector.expect.bound,
        rev: vector.expect.rev,
        concealed: vector.expect.concealed ?? [],
        items: vector.expect.items.length,
      });
    },
  );

  it.each(Object.entries(fixture.vectors))(
    "lists %s by name, kind and path only",
    async (name, vector) => {
      const code = await runCli(
        ["vault", "ls", await vectorFile(name), "--json"],
        typed(fixture.password),
      );
      expect(code).toBe(0);
      const listed: { items: JsonObject[] } = JSON.parse(out);
      expect(
        listed.items.map(({ id, name: itemName, kind }) => ({
          id,
          name: itemName,
          kind,
        })),
      ).toEqual(vector.expect.items.map(normalizedKind));
      for (const item of listed.items)
        expect(Object.keys(item).sort()).toEqual([
          "id",
          "kind",
          "name",
          "path",
        ]);
    },
  );

  it("lists an account with several methods as an .account path, with no method secret", async () => {
    const code = await runCli(
      ["vault", "ls", await vectorFile("export-personal-accounts"), "--json"],
      typed(fixture.password),
    );
    expect(code).toBe(0);
    const listed: { items: { kind: string; path: string }[] } = JSON.parse(out);
    const accounts = listed.items.filter((item) => item.kind === "account");
    expect(accounts.length).toBeGreaterThan(1);
    for (const item of accounts) expect(item.path).toMatch(/\.account$/);
    expect(out).not.toMatch(/oprfKey|"sealed"|"methods"|"secret"/);
  });

  it("prints a path per line for a person", async () => {
    const code = await runCli(
      ["vault", "ls", await vectorFile("export-personal")],
      typed(fixture.password),
    );
    expect(code).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines[0]).toContain("opensesame-vault-export");
    expect(lines.slice(1)).toHaveLength(
      fixture.vectors["export-personal"]?.expect.items.length ?? -1,
    );
  });

  it.each(Object.keys(fixture.vectors))(
    "never prints a field value from %s",
    async (name) => {
      const file = await vectorFile(name);
      await runCli(["vault", "ls", file], typed(fixture.password));
      await runCli(["vault", "ls", file, "--json"], typed(fixture.password));
      const sealed = readVaultFile(readFileSync(file, "utf8"));
      const raw = await unwrapRawVaultKeyFromPassword(
        sealed.header,
        fixture.password,
      );
      const { body } = await openVaultBody(sealed, raw);
      const values = body.items.flatMap(
        ({ id: _id, name: _name, kind: _kind, ...rest }) =>
          stringLeaves(overlapCast(rest)).filter(
            (v) => v.length >= 6 && !VOCABULARY.has(v),
          ),
      );
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) expect(out).not.toContain(value);
      // Nor any part of the device identity key a body carries (ADR 0160 §5).
      const key = body.deviceIdentityKey;
      if (key !== undefined) {
        for (const value of stringLeaves(key).filter((v) => v.length >= 6)) {
          expect(out).not.toContain(value);
        }
      }
    },
  );

  it("lists the device identity key by name, last, marked concealed, and never counts it", async () => {
    const file = await vectorFile("backup-device-identity");
    expect(await runCli(["vault", "ls", file], typed(fixture.password))).toBe(
      0,
    );
    const lines = out.trim().split("\n");
    expect(lines[0]).toContain("2 items");
    expect(lines.at(-1)).toBe("config/device-identity-key\tconcealed");
    expect(lines.slice(1, -1)).toHaveLength(2);
    out = "";
    await runCli(["vault", "ls", file, "--json"], typed(fixture.password));
    const listed: { concealed: string[]; items: JsonObject[] } =
      JSON.parse(out);
    expect(listed.concealed).toEqual(["config/device-identity-key"]);
    expect(listed.items).toHaveLength(2);
  });

  it("refuses the wrong password without output", async () => {
    const code = await runCli(
      ["vault", "verify", await vectorFile("export-personal")],
      typed("not the vector password"),
    );
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("Wrong master password.");
  });

  it("refuses a file that is not a vault", async () => {
    const path = join(dir, "other.json");
    await writeFile(path, JSON.stringify({ hello: "world" }));
    const code = await runCli(
      ["vault", "verify", path],
      typed(fixture.password),
    );
    expect(code).toBe(1);
    expect(err).toContain("Not a readable vault file");
  });

  it("reads the password from a terminal only", async () => {
    const stdin = process.stdin;
    const wasTty = stdin.isTTY;
    Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
    try {
      const code = await runCli([
        "vault",
        "verify",
        await vectorFile("export-personal"),
      ]);
      expect(code).toBe(1);
      expect(err).toContain("terminal only");
    } finally {
      Object.defineProperty(stdin, "isTTY", {
        value: wasTty,
        configurable: true,
      });
    }
  });

  it("requires a file", async () => {
    expect(await runCli(["vault", "verify"])).toBe(1);
    expect(err).toContain("requires a vault file");
  });
});

describe("applyKeys", () => {
  it("builds the password from keystrokes without echo", () => {
    expect(applyKeys("", "hunter2")).toEqual({
      typed: "hunter2",
      done: false,
      interrupted: false,
    });
    expect(applyKeys("hunter2", "\u007f\u007f3\r")).toEqual({
      typed: "hunte3",
      done: true,
      interrupted: false,
    });
    expect(applyKeys("abc", "\u0003").interrupted).toBe(true);
    expect(applyKeys("ab", "\u001b[A").typed).toBe("ab");
  });
});
