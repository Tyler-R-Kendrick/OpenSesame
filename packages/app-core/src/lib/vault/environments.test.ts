/**
 * The environments model (ADR 0194): which items are keys, the schema they
 * generate, where a required value is missing, and the edits that write it.
 * The schema is also parsed by the repo's pinned `@env-spec/parser`, the
 * reader every other tool in the repo uses, so the text is the real dialect.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type VaultBody,
  createItem,
  emptyBody,
  environmentNames,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { applyEnvironmentsEdit } from "./body-environments.js";
import {
  ENVIRONMENT_FLAG,
  type SchemaKey,
  environmentKey,
  isProductionEnvironment,
  keyWasRenamed,
  missingEnvironmentValues,
  renderEnvSchema,
  reusedProductionKeys,
} from "./environments.js";
import { T0, edit, item, keysOf, vault } from "./environments.test-support.js";

/** The bridge's JSON, read as the objects it is, keyed by variable name. */
function bridgeItems(text: string): Map<string, JsonObject> {
  const parsed = overlapCast(JSON.parse(text));
  const out = new Map<string, JsonObject>();
  if (!Array.isArray(parsed.items)) return out;
  for (const entry of parsed.items) {
    if (isJsonObject(entry) && isString(entry.key)) out.set(entry.key, entry);
  }
  return out;
}

describe("which items are keys", () => {
  it("is exactly the items that carry environments, so a vault of logins has none", () => {
    const body = vault(
      [item("a", "Stripe key"), item("b", "Bank"), item("c", "Token")],
      "development",
    );
    expect(keysOf(body)).toEqual([]);
    edit(body, { op: "add-key", itemId: "a" });
    expect(keysOf(body).map((key) => key.key)).toEqual(["STRIPE_KEY"]);
  });

  it("never counts a trashed item, and refuses a one-time share record", () => {
    const body = vault(
      [item("a", "Gone", T0, { deletedAt: "2026-02-01T00:00:00.000Z" })],
      "development",
    );
    body.items = body.items.map((entry) => ({ ...entry, environments: {} }));
    expect(keysOf(body)).toEqual([]);
    const drop: VaultBody = {
      ...emptyBody(),
      items: [{ ...createItem("drop", "One-time share"), id: "d" }],
    };
    expect(() =>
      applyEnvironmentsEdit(drop, { op: "add-key", itemId: "d" }),
    ).toThrow(/cannot be a key/);
  });

  it("derives a variable name from the item's name", () => {
    expect(environmentKey("Stripe API key")).toBe("STRIPE_API_KEY");
    expect(environmentKey("  db.password (prod) ")).toBe("DB_PASSWORD_PROD");
    expect(environmentKey("1password")).toBe("_1PASSWORD");
    expect(environmentKey("日本語")).toBe("");
  });

  it("tells two items with one derived name apart in creation order, on every device", () => {
    const body = vault(
      [
        item("z", "api key", "2026-01-03T00:00:00.000Z"),
        item("y", "API-KEY", "2026-01-01T00:00:00.000Z"),
        item("x", "Api Key", "2026-01-02T00:00:00.000Z"),
      ],
      "development",
    );
    edit(
      body,
      { op: "add-key", itemId: "z" },
      { op: "add-key", itemId: "y" },
      { op: "add-key", itemId: "x" },
    );
    const keys = keysOf(body);
    expect(keys.map((key) => [key.id, key.key])).toEqual([
      ["y", "API_KEY"],
      ["x", "API_KEY_2"],
      ["z", "API_KEY_3"],
    ]);
    expect(keys.map(keyWasRenamed)).toEqual([false, true, true]);
  });

  it("keeps the schema's own flag to itself and names a nameless key", () => {
    const body = vault([item("abcdef123", "app env"), item("b", "日本語")]);
    edit(
      body,
      { op: "add-key", itemId: "abcdef123" },
      { op: "add-key", itemId: "b" },
    );
    expect(
      keysOf(body)
        .map((key) => key.key)
        .sort(),
    ).toEqual(["APP_ENV_2", "ITEM_B"]);
  });
});

describe("the generated schema", () => {
  function sample(): VaultBody {
    const body = vault(
      [
        item("a", "Stripe API key"),
        item("b", "Database URL"),
        item("c", "Debug"),
      ],
      "development",
      "staging",
      "production",
    );
    edit(
      body,
      { op: "add-key", itemId: "a" },
      { op: "add-key", itemId: "b" },
      { op: "add-key", itemId: "c" },
      {
        op: "set-cell",
        itemId: "a",
        environment: "staging",
        cell: { required: true },
      },
      {
        op: "set-cell",
        itemId: "a",
        environment: "production",
        cell: { required: true, value: "sk_live_THIS_MUST_NOT_APPEAR" },
      },
    );
    for (const name of ["development", "staging", "production"]) {
      edit(body, {
        op: "set-cell",
        itemId: "b",
        environment: name,
        cell: { required: true },
      });
    }
    return body;
  }

  it("says required where it is, once, with forEnv", () => {
    const body = sample();
    const text = renderEnvSchema(
      environmentNames(body.environments),
      keysOf(body),
    );
    expect(text).toBe(
      [
        "# Generated by OpenSesame from this vault's environments. Holds no values.",
        "# @currentEnv=$APP_ENV @defaultRequired=false",
        "# ---",
        "",
        "# @type=enum(development, staging, production) @required @public",
        "APP_ENV=development",
        "",
        "# @sensitive @required=forEnv(staging, production)",
        "STRIPE_API_KEY=",
        "",
        "# @sensitive @required",
        "DATABASE_URL=",
        "",
        "# @sensitive",
        "DEBUG=",
        "",
      ].join("\n"),
    );
  });

  it("carries no value, however many the vault holds", () => {
    const body = sample();
    const text = renderEnvSchema(
      environmentNames(body.environments),
      keysOf(body),
    );
    expect(text).not.toContain("THIS_MUST_NOT_APPEAR");
    expect(text).not.toContain("sk_live");
  });

  it("is empty until there is an environment to describe", () => {
    expect(renderEnvSchema([], [])).toBe("");
  });

  it("parses with the repo's pinned @env-spec parser", () => {
    const bridge = fileURLToPath(
      new URL(
        "../../../../env-spec-bridge/bin/opensesame-env-parse.mjs",
        import.meta.url,
      ),
    );
    const parser = fileURLToPath(
      new URL(
        "../../../../env-spec-bridge/node_modules/@env-spec",
        import.meta.url,
      ),
    );
    if (!existsSync(bridge) || !existsSync(parser)) {
      console.warn("env-spec bridge is not installed here; skipping the parse");
      return;
    }
    const body = sample();
    const dir = mkdtempSync(join(tmpdir(), "environments-schema-"));
    try {
      const file = join(dir, ".env.schema");
      writeFileSync(
        file,
        renderEnvSchema(environmentNames(body.environments), keysOf(body)),
      );
      const byKey = bridgeItems(
        execFileSync(process.execPath, [bridge, file], {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "" },
        }),
      );
      expect([...byKey.keys()]).toEqual([
        ENVIRONMENT_FLAG,
        "STRIPE_API_KEY",
        "DATABASE_URL",
        "DEBUG",
      ]);
      expect(byKey.get("STRIPE_API_KEY")).toMatchObject({
        required: true,
        sensitive: true,
        value: null,
      });
      expect(byKey.get("DATABASE_URL")).toMatchObject({ required: true });
      expect(byKey.get("DEBUG")).toMatchObject({
        required: false,
        sensitive: true,
      });
      expect(byKey.get(ENVIRONMENT_FLAG)).toMatchObject({ public: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what is missing", () => {
  const names = ["development", "production"];

  function keys(): SchemaKey[] {
    const body = vault([item("a", "Token"), item("b", "Url")], ...names);
    edit(
      body,
      { op: "add-key", itemId: "a" },
      { op: "add-key", itemId: "b" },
      {
        op: "set-cell",
        itemId: "a",
        environment: "production",
        cell: { required: true },
      },
      {
        op: "set-cell",
        itemId: "b",
        environment: "development",
        cell: { required: true, value: "http://localhost" },
      },
    );
    return keysOf(body);
  }

  it("names each environment that has a required key with no value", () => {
    expect(missingEnvironmentValues(names, keys())).toEqual([
      { environment: "production", keys: ["TOKEN"] },
    ]);
  });

  it("is quiet once the value is there, or the key is not required", () => {
    const filled = keys().map((key) =>
      key.key === "TOKEN"
        ? { ...key, cells: { production: { required: true, value: "x" } } }
        : key,
    );
    expect(missingEnvironmentValues(names, filled)).toEqual([]);
    const unrequired = keys().map((key) => ({ ...key, cells: {} }));
    expect(missingEnvironmentValues(names, unrequired)).toEqual([]);
  });

  it("ignores a requirement for an environment that no longer exists", () => {
    expect(missingEnvironmentValues(["development"], keys())).toEqual([]);
  });
});

describe("a value production shares", () => {
  function shared(prod: string, other: string): SchemaKey[] {
    return [
      {
        id: "a",
        key: "TOKEN",
        name: "Token",
        cells: { production: { value: prod }, staging: { value: other } },
      },
    ];
  }

  it("is named by key when production and another environment hold one value", () => {
    expect(
      reusedProductionKeys(["staging", "production"], shared("s", "s")),
    ).toEqual(["TOKEN"]);
  });

  it("is quiet for different values, empty values, or no production", () => {
    const both = ["staging", "production"];
    expect(reusedProductionKeys(both, shared("a", "b"))).toEqual([]);
    expect(reusedProductionKeys(both, shared("", ""))).toEqual([]);
    expect(reusedProductionKeys(["staging", "qa"], shared("s", "s"))).toEqual(
      [],
    );
  });

  it("reads production from its name, not from a substring", () => {
    for (const name of ["production", "prod", "prod-eu", "eu.prod"]) {
      expect(isProductionEnvironment(name)).toBe(true);
    }
    for (const name of ["preprod", "nonprod", "development", "reproduce"]) {
      expect(isProductionEnvironment(name)).toBe(false);
    }
  });
});
