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

/**
 * Record every value the page writes to `sessionStorage`, as it writes it:
 * the page leaves for Pages, and its storage is not readable from the error
 * page a held navigation lands on. What was written is what a copy of the
 * tab's storage would hold.
 */
async function recordStorageWrites(page) {
  const writes = [];
  await page.exposeFunction("__recordWrite", (key, value) => {
    writes.push({ key, value });
  });
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function record(key, value) {
      if (this === globalThis.sessionStorage)
        globalThis.__recordWrite(key, value);
      return set.call(this, key, value);
    };
  });
  return writes;
}

export async function spaRpJourney(env) {
  const { page, issuer, ids, siopVerify } = env;
  const watched = watch(page, issuer, SPA_ORIGIN);
  const writes = await recordStorageWrites(page);
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

  // Nothing of the login was written in the clear (ADR 0149): every value is
  // an at-rest seal, and neither the state nor the nonce is readable in one.
  const sent = watched.asked.at(-1);
  expect(writes.length).toBeGreaterThan(0);
  for (const { value } of writes) {
    expect(value.startsWith("osc1.")).toBe(true);
    for (const secret of [
      sent.searchParams.get("state"),
      sent.searchParams.get("nonce"),
      ids.appOneId,
    ]) {
      expect(value).not.toContain(secret);
    }
  }
  console.log(
    `PASS spa at rest: ${writes.length} sessionStorage writes, every one an osc1. seal with the state, nonce and application id unreadable in it`,
  );

  // The same response again, in the same tab: the state was taken once.
  // (A hash-only change would not reload the page, so leave it first.)
  await page.goto("about:blank");
  await page.goto(watched.answered.at(-1));
  await expectRefused(page, "login_unknown");
  console.log("PASS spa replay: the same response is refused (login_unknown)");

  // A login's response opened in a tab that did not start it: this page's form
  // of the binding is the tab's own sealed storage, and another tab has none.
  const other = await page.context().newPage();
  await other.goto(watched.answered.at(-1));
  await expectRefused(other, "login_unknown");
  await other.close();
  console.log(
    "PASS spa binding: a valid response opened in another tab is refused (login_unknown)",
  );
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
