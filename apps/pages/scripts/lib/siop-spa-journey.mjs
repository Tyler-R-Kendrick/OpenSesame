/**
 * The example **single-page relying party** (`examples/siop-rp/src/spa`) on its
 * own origin signs in against the built Pages app (ADR 0161): it reads
 * `siop-metadata.json` cross-origin, redirects, and verifies the token in the
 * browser. Also the check that the built `dist/` publishes exactly the bytes
 * the kit says a build publishes.
 */
import fs from "node:fs";
import { expect } from "@playwright/test";
import {
  answer,
  expectRefused,
  expectVerified,
  watch,
} from "./siop-rp-steps.mjs";

export const SPA_ORIGIN = "https://spa-rp.example.test";

/** Serve a built single-page RP (`vite build`, write:false) from its own origin. */
export async function routeSpa(context, bundle) {
  const files = new Map();
  for (const file of bundle) {
    files.set(
      `/${file.fileName}`,
      file.type === "chunk"
        ? { type: "text/javascript", body: file.code }
        : { type: "text/html", body: file.source },
    );
  }
  files.set("/", files.get("/index.html"));
  await context.route(`${SPA_ORIGIN}/**`, (route) => {
    const served = files.get(new URL(route.request().url()).pathname);
    if (!served) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({
      status: 200,
      headers: { "content-type": served.type },
      body: served.body,
    });
  });
}

export async function spaRpJourney(env) {
  const { page, issuer, ids, siopVerify } = env;
  const watched = watch(page, issuer, SPA_ORIGIN);
  await page.goto(`${SPA_ORIGIN}/`);
  await page.locator("#signin").click();
  await answer(page, ids.personName, SPA_ORIGIN);
  const shown = await expectVerified(page);
  const verified = await siopVerify.verifySiopRedirect(
    watched.answered.at(-1),
    {
      issuer,
      clientId: ids.appOneId,
      nonce: watched.asked.at(-1).searchParams.get("nonce"),
    },
  );
  expect(shown.subject).toBe(verified.sub);
  expect(page.url()).toBe(`${SPA_ORIGIN}/`);
  console.log(
    "PASS spa allow: discovery read cross-origin, the single-page relying party verified the token in the browser",
  );

  // The same response again, in the same tab: the state was taken once.
  // (A hash-only change would not reload the page, so leave it first.)
  await page.goto("about:blank");
  await page.goto(watched.answered.at(-1));
  await expectRefused(page, "login_unknown");
  console.log("PASS spa replay: the same response is refused (login_unknown)");
}

/** The published bytes are exactly what the kit says a build publishes. */
export function checkPublishedMetadata(dist, siopVerify, origin, base) {
  const published = fs.readFileSync(`${dist}/siop-metadata.json`, "utf8");
  expect(published).toBe(siopVerify.expectedMetadataText(origin, base));
  expect(published).not.toMatch(/token_endpoint|jwks_uri/);
  expect(JSON.parse(published).opensesame.conventional_oidc).toBe(false);
  expect(fs.existsSync(`${dist}/.well-known`)).toBe(false);
  console.log(
    "PASS metadata artifact: dist/siop-metadata.json is byte-identical to the kit's document, claims no token endpoint or jwks_uri, and no .well-known is shipped",
  );
}
