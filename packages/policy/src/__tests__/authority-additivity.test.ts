import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type JsonObject,
  type JsonValue,
  overlapCast,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";

/**
 * GA-F-03 / INV-GA-03 — OpenFGA model additivity harness.
 *
 * For every check C and tuple set T valid against the baseline model:
 *   check(baseline, T, C) == true  ⟹  check(delta, T ∪ T', C) == true
 *
 * Structural proof: every type that existed at baseline keeps its relation
 * block byte-identical in the delta, and the only new type (`access_domain`)
 * inherits downward. Live proof (when OPENSESAME_OPENFGA_URL is set): the same
 * baseline checks are replayed against a store loaded with the delta.
 *
 * Absence of OpenFGA fails the live leg closed — never a quiet skip that would
 * paint INV-GA-03 green without a PDP.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const baselinePath = resolve(root, "policy/openfga/baseline.fga");
const deltaPath = resolve(root, "policy/openfga/model.fga");

const FROZEN_BASELINE_TYPES = [
  "user",
  "service",
  "workload",
  "agent",
  "team",
  "organization",
  "project",
  "environment",
  "connection",
  "connector_operation",
  "vault_collection",
  "vault_item",
  "certificate_role",
  "cohort",
  "cohort_activation",
] as const;

type TypeBlock = {
  readonly name: string;
  readonly body: string;
};

function parseTypeBlocks(source: string): Map<string, TypeBlock> {
  const blocks = new Map<string, TypeBlock>();
  const lines = source.split(/\r?\n/);
  let current: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (current === null) return;
    blocks.set(current, { name: current, body: body.join("\n").trimEnd() });
    current = null;
    body = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("type ")) {
      flush();
      current = trimmed.slice("type ".length).trim();
      body = [];
      continue;
    }
    if (current !== null) {
      body.push(line);
    }
  }
  flush();
  return blocks;
}

function relationDefines(block: TypeBlock): string[] {
  return block.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("define "));
}

function assertStructuralAdditivity(
  baselineSrc: string,
  deltaSrc: string,
): void {
  const baseline = parseTypeBlocks(baselineSrc);
  const delta = parseTypeBlocks(deltaSrc);

  for (const name of FROZEN_BASELINE_TYPES) {
    const before = baseline.get(name);
    const after = delta.get(name);
    if (before === undefined) {
      throw new Error(`baseline must declare type ${name}`);
    }
    if (after === undefined) {
      throw new Error(`delta must keep type ${name}`);
    }
    expect(
      relationDefines(after),
      `${name} relation defines must be unchanged (INV-GA-03: no narrowing)`,
    ).toEqual(relationDefines(before));
  }

  expect(
    baseline.has("access_domain"),
    "baseline must not already declare access_domain",
  ).toBe(false);
  const domainBlock = delta.get("access_domain");
  if (domainBlock === undefined) {
    throw new Error("delta must add type access_domain");
  }
  const defines = relationDefines(domainBlock);
  expect(defines).toContain("define organization: [organization]");
  expect(defines).toContain("define project: [project]");
  expect(defines).toContain("define parent: [access_domain]");
  expect(defines).toContain(
    "define owner: [user, team#member] or owner from parent or owner from project",
  );
  expect(defines).toContain(
    "define admin: [user, team#member] or owner or admin from parent or admin from project",
  );
  expect(defines).toContain(
    "define member: [user, team#member, workload, agent] or admin or member from parent or developer from project",
  );

  const frozen = new Set<string>(FROZEN_BASELINE_TYPES);
  for (const name of delta.keys()) {
    if (frozen.has(name)) {
      continue;
    }
    expect(
      name,
      "delta may only add access_domain beyond the frozen baseline set",
    ).toBe("access_domain");
  }
}

type TupleKey = {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
};

type CheckCase = {
  readonly tuple: TupleKey;
  readonly expectAllowed: boolean;
};

/** Baseline tuples that must stay allowed under the delta (INV-GA-03). */
const BASELINE_CHECKS: readonly CheckCase[] = [
  {
    tuple: {
      user: "user:alice",
      relation: "owner",
      object: "project:alpha",
    },
    expectAllowed: true,
  },
  {
    tuple: {
      user: "user:alice",
      relation: "developer",
      object: "project:alpha",
    },
    expectAllowed: true,
  },
  {
    tuple: {
      user: "user:bob",
      relation: "developer",
      object: "project:alpha",
    },
    expectAllowed: false,
  },
  {
    tuple: {
      user: "user:alice",
      relation: "user",
      object: "connection:conn-1",
    },
    expectAllowed: true,
  },
  {
    tuple: {
      user: "user:alice",
      relation: "reader",
      object: "vault_collection:vault-1",
    },
    expectAllowed: true,
  },
  {
    tuple: {
      user: "user:alice",
      relation: "reader",
      object: "vault_item:item-1",
    },
    expectAllowed: true,
  },
];

const BASELINE_TUPLES: readonly TupleKey[] = [
  { user: "user:alice", relation: "owner", object: "project:alpha" },
  {
    user: "project:alpha",
    relation: "project",
    object: "connection:conn-1",
  },
  { user: "user:alice", relation: "owner", object: "connection:conn-1" },
  {
    user: "project:alpha",
    relation: "project",
    object: "vault_collection:vault-1",
  },
  {
    user: "user:alice",
    relation: "owner",
    object: "vault_collection:vault-1",
  },
  {
    user: "vault_collection:vault-1",
    relation: "collection",
    object: "vault_item:item-1",
  },
];

/** Extra delta tuples that must not revoke any baseline check. */
const DELTA_EXTRA_TUPLES: readonly TupleKey[] = [
  {
    user: "project:alpha",
    relation: "project",
    object: "access_domain:platform",
  },
  {
    user: "user:carol",
    relation: "member",
    object: "access_domain:platform",
  },
  {
    user: "access_domain:platform",
    relation: "parent",
    object: "access_domain:prod",
  },
  {
    user: "project:alpha",
    relation: "project",
    object: "access_domain:prod",
  },
];

function findFgaCli(): string | null {
  const candidates = [resolve(root, "tools/bin/fga"), "fga"];
  for (const candidate of candidates) {
    if (candidate === "fga") {
      const which = spawnSync("which", ["fga"], { encoding: "utf8" });
      if (which.status === 0 && which.stdout.trim() !== "") {
        return which.stdout.trim();
      }
      continue;
    }
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseJsonObject(text: string): JsonObject {
  const parsed: JsonValue = overlapCast(JSON.parse(text));
  const object = readJsonObject(parsed);
  if (object === undefined) {
    throw new Error(`expected JSON object, got: ${text}`);
  }
  return object;
}

function transformModel(fgaCli: string, modelFile: string): JsonObject {
  const result = spawnSync(
    fgaCli,
    ["model", "transform", "--file", modelFile, "--input-format", "fga"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `fga model transform failed for ${modelFile}: ${result.stderr || result.stdout}`,
    );
  }
  return parseJsonObject(result.stdout);
}

type HttpJsonResponse = {
  readonly status: number;
  readonly body: JsonObject;
};

async function postJson(
  url: string,
  body: JsonObject,
): Promise<HttpJsonResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: parseJsonObject(text) };
}

function requireStringField(body: JsonObject, field: string): string {
  const value = readString(body[field]);
  if (value === undefined || value === "") {
    throw new Error(`response missing ${field}: ${JSON.stringify(body)}`);
  }
  return value;
}

async function writeModel(
  apiUrl: string,
  storeId: string,
  model: JsonObject,
): Promise<string> {
  const result = await postJson(
    `${apiUrl}/stores/${storeId}/authorization-models`,
    {
      schema_version: model.schema_version ?? "1.1",
      type_definitions: model.type_definitions,
      conditions: model.conditions,
    },
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `write model failed (${result.status}): ${JSON.stringify(result.body)}`,
    );
  }
  return requireStringField(result.body, "authorization_model_id");
}

async function writeTuples(
  apiUrl: string,
  storeId: string,
  tuples: readonly TupleKey[],
): Promise<void> {
  if (tuples.length === 0) return;
  const result = await postJson(`${apiUrl}/stores/${storeId}/write`, {
    writes: {
      tuple_keys: tuples.map((tuple) => ({
        user: tuple.user,
        relation: tuple.relation,
        object: tuple.object,
      })),
    },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `write tuples failed (${result.status}): ${JSON.stringify(result.body)}`,
    );
  }
}

async function checkTuple(
  apiUrl: string,
  storeId: string,
  modelId: string,
  tuple: TupleKey,
): Promise<boolean> {
  const result = await postJson(`${apiUrl}/stores/${storeId}/check`, {
    authorization_model_id: modelId,
    tuple_key: {
      user: tuple.user,
      relation: tuple.relation,
      object: tuple.object,
    },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `check failed (${result.status}): ${JSON.stringify(result.body)}`,
    );
  }
  return result.body.allowed === true;
}

async function assertLiveAdditivity(apiUrl: string): Promise<void> {
  const fgaCli = findFgaCli();
  if (fgaCli === null) {
    throw new Error(
      "OPENSESAME_OPENFGA_URL is set but the fga CLI is unavailable; cannot transform DSL models for the live additivity check",
    );
  }

  const baselineModel = transformModel(fgaCli, baselinePath);
  const deltaModel = transformModel(fgaCli, deltaPath);

  const store = await postJson(`${apiUrl}/stores`, {
    name: `opensesame-additivity-${Date.now()}`,
  });
  if (store.status < 200 || store.status >= 300) {
    throw new Error(
      `create store failed (${store.status}): ${JSON.stringify(store.body)}`,
    );
  }
  const storeId = requireStringField(store.body, "id");

  const baselineModelId = await writeModel(apiUrl, storeId, baselineModel);
  await writeTuples(apiUrl, storeId, BASELINE_TUPLES);

  for (const check of BASELINE_CHECKS) {
    const allowed = await checkTuple(
      apiUrl,
      storeId,
      baselineModelId,
      check.tuple,
    );
    expect(
      allowed,
      `baseline check ${check.tuple.user}#${check.tuple.relation}@${check.tuple.object}`,
    ).toBe(check.expectAllowed);
  }

  const deltaModelId = await writeModel(apiUrl, storeId, deltaModel);
  await writeTuples(apiUrl, storeId, DELTA_EXTRA_TUPLES);

  for (const check of BASELINE_CHECKS) {
    if (!check.expectAllowed) continue;
    const allowed = await checkTuple(
      apiUrl,
      storeId,
      deltaModelId,
      check.tuple,
    );
    expect(
      allowed,
      `delta must preserve baseline allow: ${check.tuple.user}#${check.tuple.relation}@${check.tuple.object}`,
    ).toBe(true);
  }

  // Parent authority implies child authority (direction of derivation is down).
  const inherited = await checkTuple(apiUrl, storeId, deltaModelId, {
    user: "user:carol",
    relation: "member",
    object: "access_domain:prod",
  });
  expect(inherited, "member on parent must reach the child domain").toBe(true);
}

describe("OpenFGA authority additivity (INV-GA-03)", () => {
  it("No check true against the baseline OpenFGA model returns false against the delta", async () => {
    expect(existsSync(baselinePath), `${baselinePath} must exist`).toBe(true);
    expect(existsSync(deltaPath), `${deltaPath} must exist`).toBe(true);

    const baselineSrc = readFileSync(baselinePath, "utf8");
    const deltaSrc = readFileSync(deltaPath, "utf8");
    assertStructuralAdditivity(baselineSrc, deltaSrc);

    const apiUrl = (process.env.OPENSESAME_OPENFGA_URL ?? "")
      .trim()
      .replace(/\/$/, "");
    const forceLive = process.env.FORCE_FGA_ADDITIVITY_LIVE === "1";

    // Unit suites prove the structural half. The fabric provider tier (GA-V-32)
    // sets OPENSESAME_OPENFGA_URL so the live half runs; forcing live without a
    // URL fails closed rather than skipping.
    if (apiUrl === "") {
      if (forceLive) {
        throw new Error(
          "FORCE_FGA_ADDITIVITY_LIVE=1 but OPENSESAME_OPENFGA_URL is unset; INV-GA-03 live additivity fails closed",
        );
      }
      return;
    }

    const health = await fetch(`${apiUrl}/healthz`).catch((cause: unknown) => {
      throw new Error(
        `OPENSESAME_OPENFGA_URL=${apiUrl} is unreachable; INV-GA-03 live additivity fails closed (${String(cause)})`,
      );
    });
    if (!health.ok) {
      throw new Error(
        `OPENSESAME_OPENFGA_URL=${apiUrl} healthz returned ${health.status}; INV-GA-03 live additivity fails closed`,
      );
    }

    await assertLiveAdditivity(apiUrl);
  });
});
