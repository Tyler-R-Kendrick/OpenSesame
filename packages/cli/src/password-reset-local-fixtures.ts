import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserDriver,
  CandidateCustody,
  type Observation,
  type ResetRun,
} from "@opensesame/cua-password-reset";
import type { PasswordMethod } from "@opensesame/vault-core";
import { vi } from "vitest";
import {
  BUNDLED_LOCAL_MODULE,
  type PasswordResetConfiguration,
} from "./password-reset-config.js";
import type { ResetRuntimeContext } from "./password-reset-runtime.js";
import type { ResetVault } from "./password-reset-vault.js";

const directories: string[] = [];

export async function cleanupConfigDirs(): Promise<void> {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
}

export const ORIGIN = "http://127.0.0.1:4317";

export function recipeJson() {
  return JSON.stringify({
    schemaVersion: 1,
    review: "approved",
    domain: "127.0.0.1",
    entryPath: "/reset",
    allowedOrigins: [ORIGIN],
    verification: {
      path: "/account",
      expectedLabel: "Sign out",
      loginPath: "/login",
      loginLabel: "Sign in",
    },
    steps: [
      { id: "open", primitive: "navigate", path: "/reset" },
      {
        id: "identify",
        primitive: "fill-field",
        ref: "e1",
        expectedLabel: "Email",
        purpose: "identifier",
      },
      { id: "mail", primitive: "await-email-link" },
      {
        id: "password",
        primitive: "fill-field",
        ref: "e3",
        expectedLabel: "New password",
        purpose: "new-password",
      },
      {
        id: "submit",
        primitive: "submit",
        ref: "e4",
        expectedLabel: "Save password",
      },
      { id: "verify", primitive: "verify-login" },
    ],
  });
}

export async function configDir(config: PasswordResetConfiguration) {
  const directory = await mkdtemp(join(tmpdir(), "reset-local-"));
  directories.push(directory);
  await writeFile(join(directory, "recipe.json"), recipeJson());
  await writeFile(join(directory, "reset.json"), JSON.stringify(config));
  return directory;
}

export function bundledConfig(): PasswordResetConfiguration {
  return {
    schemaVersion: 1,
    origin: ORIGIN,
    itemId: "item-1",
    transport: "cdp",
    recipe: "recipe.json",
    runtime: { module: BUNDLED_LOCAL_MODULE, maxSteps: 40 },
  };
}

export function fieldsFor(path: string): Observation["fields"] {
  if (path === "/reset/link")
    return [
      { ref: "e3", kind: "password", label: "New password" },
      { ref: "e4", kind: "button", label: "Save password" },
    ];
  if (path === "/reset")
    return [
      { ref: "e1", kind: "email", label: "Email" },
      { ref: "e2", kind: "button", label: "Send reset link" },
    ];
  return [];
}

export function fakeDriver() {
  let path = "/reset";
  const driver: BrowserDriver = {
    open: vi.fn(async (url: string) => {
      path = new URL(url).pathname;
    }),
    snapshot: vi.fn(async () => ({
      id: crypto.randomUUID(),
      origin: ORIGIN,
      fields: fieldsFor(path),
    })),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    fillSecret: vi.fn(async () => {}),
    pageUrl: vi.fn(async () => new URL(path, ORIGIN).href),
    close: vi.fn(async () => {}),
  };
  return driver;
}

const METHOD: PasswordMethod = {
  id: "password-1",
  type: "password",
  generator: {
    id: "derived",
    counter: 1,
    rules: {
      length: 24,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
      avoidAmbiguous: false,
      minDigits: 1,
      minSymbols: 1,
    },
  },
  pepper: true,
  pepperAt: "end",
  secret: Buffer.alloc(32, 7).toString("base64"),
  changedAt: "2026-10-28T00:00:00.000Z",
};

export function localContext(maxSteps = 40): ResetRuntimeContext {
  const config = {
    ...bundledConfig(),
    runtime: { module: BUNDLED_LOCAL_MODULE, maxSteps },
  };
  const run: ResetRun = {
    id: "run-1",
    domain: "127.0.0.1",
    origin: ORIGIN,
    itemId: "item-1",
    transport: "cdp",
    grantIds: {},
    cursor: 0,
    status: "running",
    updatedAt: "2026-10-28T00:00:00.000Z",
    recipe: JSON.parse(recipeJson()),
  };
  // SAFETY: the local runtime never reads the vault store.
  const store = {} as ResetVault["store"];
  // SAFETY: the local runtime reads only the item id and username.
  const item = {
    id: "item-1",
    username: "person@example.test",
  } as ResetVault["item"];
  return {
    run,
    candidate: new CandidateCustody(
      METHOD,
      () => "person-pepper",
      () => {},
    ),
    item,
    store,
    loaded: { config, directory: "/tmp", recipe: run.recipe },
    agent: {
      headers: vi.fn(async () => ({
        authorization: "Bearer [REDACTED]",
        "x-opensesame-agent-client": crypto.randomUUID(),
        "x-opensesame-agent-audience": "urn:opensesame:agent:mcp-host" as const,
      })),
      forget: vi.fn(),
    },
  };
}

export function localSandbox(driver: ReturnType<typeof fakeDriver>) {
  return {
    browser: driver,
    session: "cua-test",
    close: vi.fn(async () => {}),
  };
}
