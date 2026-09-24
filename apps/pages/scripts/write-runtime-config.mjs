#!/usr/bin/env node
/**
 * Write `dist/os-runtime-config.json`, the deployment's endpoints, from the
 * `PAGES_*` environment. The one step every host of the built app runs:
 * GitHub Pages (`deploy-pages.yml`) and Vercel (`vercel.json`) alike.
 *
 * With none of the variables set the empty file from the build stays, and
 * the app is complete without a backend (ADR 0090). `PAGES_CONNECT_CALLBACK_BASE=/`
 * means the relay is served by this same deployment (`apps/pages/api`).
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = {
  identityApi: "PAGES_IDENTITY_API",
  hostApi: "PAGES_HOST_API",
  daemonApi: "PAGES_DAEMON_API",
  mfaAppUrl: "PAGES_MFA_APP_URL",
  supportAgentUrl: "PAGES_SUPPORT_AGENT_URL",
  connectCallbackBase: "PAGES_CONNECT_CALLBACK_BASE",
};

export function runtimeConfig(environment) {
  return Object.fromEntries(
    Object.entries(KEYS)
      .map(([key, name]) => [key, environment[name]?.trim()])
      .filter(([, value]) => value),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = runtimeConfig(process.env);
  if (Object.keys(config).length === 0) {
    console.log(
      "no PAGES_* variables set — keeping the empty os-runtime-config.json",
    );
  } else {
    const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
    writeFileSync(
      resolve(dist, "os-runtime-config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    console.log(`os-runtime-config.json: ${Object.keys(config).join(", ")}`);
  }
}
