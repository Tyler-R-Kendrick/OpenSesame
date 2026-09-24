#!/usr/bin/env node
/**
 * Product-experience contract suite. Drives shipped modules for Visual/Source,
 * navigation, recipes, OIDC claims/workload, SCIM groups, replica enrollment,
 * and optional Pages browser gates when dist + Chromium are present.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const oauth2ProxyCandidates = [
  process.env.OAUTH2_PROXY_BIN,
  "/tmp/oauth2-proxy-smoke/oauth2-proxy-v7.8.2.linux-arm64/oauth2-proxy",
  "/tmp/oauth2-proxy-smoke/oauth2-proxy",
].filter((path) => isString(path) && path.length > 0);
for (const candidate of oauth2ProxyCandidates) {
  if (existsSync(candidate)) {
    process.env.OAUTH2_PROXY_BIN = candidate;
    process.env.OPENSESAME_REQUIRE_OAUTH2_PROXY = "1";
    break;
  }
}
const pages = join(root, "apps/pages");

function run(filter, args) {
  const result = spawnSync(
    "pnpm",
    ["--filter", filter, "exec", "vitest", "run", "--maxWorkers=4", ...args],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runPagesScript(script) {
  const result = spawnSync("node", [join(pages, "scripts", script)], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_BASE: process.env.VITE_BASE ?? "/OpenSesame/",
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("@opensesame/app-core", [
  "src/lib/configuration",
  "src/lib/vault/item-types.test.ts",
  "src/lib/site-broker-delivery.test.ts",
]);

run("@opensesame/pages", [
  "src/sections/settings/page-tree.test.ts",
  "src/sections/settings/ItemTypesPanel.test.tsx",
  "src/sections/identity/ApplicationSurfaces.test.tsx",
  "src/sections/identity/LocalApplicationSettings.test.tsx",
  "src/sections/identity/management.test.tsx",
  "src/sections/SettingsSection.test.tsx",
  "src/sections/settings/GeneralPrefsPanel.test.tsx",
  "src/lib/keymap.behavior.test.ts",
  "src/sections/settings/SecretConfigsPanel.test.tsx",
  "src/sections/settings/SecretConfigEmptyCreate.test.tsx",
]);

const oauthArgs = [
  "src/__tests__/project-account-claims.test.ts",
  "src/__tests__/client-credentials.test.ts",
  "src/__tests__/create-provider-callbacks.test.ts",
].filter((path) => existsSync(join(root, "packages/oauth-provider", path)));
if (oauthArgs.length > 0) {
  run("@opensesame/oauth-provider", oauthArgs);
}

const scimArgs = [
  "src/__tests__/scim.test.ts",
  "src/__tests__/scim-groups.test.ts",
  "src/__tests__/enrollment-tickets.test.ts",
  "src/__tests__/replica-enrollment.test.ts",
  "src/__tests__/replica-scim.test.ts",
  "src/__tests__/adv-23-admin.test.ts",
  "src/__tests__/oauth-claims.test.ts",
  "src/__tests__/adv-34-ldap.test.ts",
  "src/__tests__/client-credentials-token.test.ts",
  "src/__tests__/client-credentials-db.test.ts",
  "src/__tests__/replica-cc-scim.test.ts",
  "src/__tests__/oauth2-proxy-contract.test.ts",
  "src/__tests__/oauth2-proxy-live.test.ts",
].filter((path) => existsSync(join(root, "packages/control-plane", path)));
if (scimArgs.length > 0) {
  run("@opensesame/control-plane", scimArgs);
}

const migrateArgs = ["tests/migrate-0027-0028.test.ts"].filter((path) =>
  existsSync(join(root, "packages/database", path)),
);
if (migrateArgs.length > 0) {
  run("@opensesame/database", migrateArgs);
}

const dist = join(pages, "dist/index.html");
const chromium =
  process.env.PLAYWRIGHT_CHROMIUM ||
  (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : "");
const skipPages =
  process.env.OPENSESAME_VERIFY_PAGES === "0" ||
  !existsSync(dist) ||
  (chromium !== "" && !existsSync(chromium));
if (skipPages) {
  console.log(
    "verify:experience: skipping Pages browser gates (dist or Chromium unavailable).",
  );
} else {
  if (chromium && !process.env.PLAYWRIGHT_CHROMIUM) {
    process.env.PLAYWRIGHT_CHROMIUM = chromium;
  }
  runPagesScript("verify-static-origin.mjs");
  runPagesScript("verify-keyboard.mjs");
  runPagesScript("verify-mobile.mjs");
  runPagesScript("verify-auth-flow.mjs");
  runPagesScript("verify-local-iam.mjs");
  runPagesScript("verify-experience-journeys.mjs");
}
