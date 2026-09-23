import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrapRawVaultKeyFromPassword } from "@opensesame/app-core/lib/vault/crypto.js";
import {
  openVaultBody,
  readVaultFile,
} from "@opensesame/app-core/lib/vault/vault-file.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
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
  };
};
type Fixture = { password: string; vectors: Record<string, Vector> };

const fixture: Fixture = overlapCast(
  JSON.parse(
    readFileSync(
      createRequire(import.meta.url).resolve(
        "@opensesame/app-core/lib/vault/fixtures/vault-vectors.json",
      ),
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

const typed = (password: string) => ({
  readPassword: vi.fn(async () => password),
});

/** Every string anywhere under `value`. */
function stringLeaves(value: object | string | null): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(stringLeaves);
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
      ).toEqual(vector.expect.items);
      for (const item of listed.items)
        expect(Object.keys(item).sort()).toEqual([
          "id",
          "kind",
          "name",
          "path",
        ]);
    },
  );

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
          stringLeaves(overlapCast(rest)).filter((v) => v.length >= 6),
      );
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) expect(out).not.toContain(value);
    },
  );

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
    const stdin = process.stdin as NodeJS.ReadStream;
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
