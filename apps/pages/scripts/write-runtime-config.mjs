#!/usr/bin/env node
/**
 * Write `dist/os-runtime-config.json` from optional `PAGES_*` environment.
 * GitHub Pages (`deploy-pages.yml`) and Vercel (`vercel.json`) alike.
 *
 * Host / Identity / daemon are **not** stamped here (Tyler 2026-10-08): the
 * PWA is static (ADR 0090). Sessions are browser WebRTC; a relay peer is
 * optional (ADR 0181). With none of the remaining variables set the empty
 * file from the build stays.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Only non-backend optional stamps. Host/Identity/daemon `pagesRuntimeKey`
// rows were removed from spec/config/endpoints.json. Linear's public OAuth
// client id is a connector stamp, not a plane URL (#934).
const KEYS = {
  supportAgentUrl: "PAGES_SUPPORT_AGENT_URL",
  linearClientId: "PAGES_LINEAR_CLIENT_ID",
};

/** Refused if someone still exports the old backend stamps in CI. */
const FORBIDDEN = [
  "PAGES_IDENTITY_API",
  "PAGES_HOST_API",
  "PAGES_DAEMON_API",
  "PAGES_CONNECT_CALLBACK_BASE",
];

export function runtimeConfig(environment) {
  for (const name of FORBIDDEN) {
    const value = environment[name]?.trim();
    if (value) {
      throw new Error(
        `${name} is set but Pages is a static app with no Identity/Host/daemon backend and no serverless connect relay. Unset it.`,
      );
    }
  }
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
      "no optional PAGES_* variables set — keeping the empty os-runtime-config.json",
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
