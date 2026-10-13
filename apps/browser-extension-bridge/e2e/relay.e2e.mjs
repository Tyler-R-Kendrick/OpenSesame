// The bridge in a real Chromium, end to end: a page that provider servers
// refuse cannot read their answers; with the bridge switched on for its origin
// and the host allowed, the same page reads them, and nothing else changes.
import assert from "node:assert/strict";
import test from "node:test";
import { attachPopup, connectBrowser } from "./harness/cdp.mjs";
import { GOOD } from "./harness/provider.mjs";
import { startSession } from "./harness/session.mjs";

const HOST_URL = "https://api.plivo.com/v1/Account/MA/";
const fetchOf = (overrides = {}) => ({
  op: "fetch",
  request: {
    providerId: "plivo",
    url: HOST_URL,
    method: "GET",
    headers: [["authorization", GOOD]],
    body: null,
    ...overrides,
  },
});

async function openPopup(session, tab, state) {
  state.browser ??= await connectBrowser(session.profile);
  session.cleanups.push(() => state.browser.close());
  await tab.bringToFront();
  const worker = await session.worker();
  await worker.evaluate(() => chrome.action.openPopup());
  const popup = await attachPopup(state.browser, session.popupUrl, state.known);
  state.known.add(popup.targetId);
  await popup.waitFor(() => document.querySelector("[role=switch]") !== null);
  return popup;
}

const switchOn = (popup) =>
  popup.evaluate(
    () =>
      document.querySelector("[role=switch]").getAttribute("aria-checked") ===
      "true",
  );

test("a page that cannot read a provider's answer reads it through the bridge", async (t) => {
  const session = await startSession();
  t.after(() => session.close());
  const state = { browser: null, known: new Set() };
  const tab = await session.context.newPage();
  await tab.goto(`${session.page.origin}/`);

  // The problem: the provider answers without any CORS header, so the page cannot read it.
  const direct = await tab.evaluate(async (url) => {
    try {
      await fetch(url, { headers: { Authorization: "Basic abc" } });
      return "read";
    } catch (error) {
      return error.name;
    }
  }, HOST_URL);
  assert.equal(direct, "TypeError");

  // Nothing is relayed until a person switches the bridge on for this origin.
  assert.equal(
    await tab.evaluate(() => window.ask({ op: "hello" }, 600)),
    null,
  );

  const popup = await openPopup(session, tab, state);
  assert.equal(await switchOn(popup), false);
  await popup.click("[role=switch]");
  await popup.waitFor(
    () =>
      document.querySelector("[role=switch]").getAttribute("aria-checked") ===
      "true",
  );
  await popup.close();

  await tab.reload();
  const hello = await tab.evaluate(() => window.ask({ op: "hello" }));
  assert.equal(hello.ok, true);
  assert.deepEqual(hello.result.granted, ["api.plivo.com"]);
  assert.equal(hello.result.bridge, "opensesame-connector-bridge");

  // A refused key and an accepted one, both readable now.
  const bad = await tab.evaluate(
    (body) => window.ask(body),
    fetchOf({ headers: [["authorization", "Basic nope"]] }),
  );
  assert.equal(bad.ok, true);
  assert.equal(bad.result.status, 401);
  assert.equal(bad.result.body, '{"error":"unauthorized"}');
  const good = await tab.evaluate((body) => window.ask(body), fetchOf());
  assert.equal(good.result.status, 200);
  assert.equal(JSON.parse(good.result.body).auth_id, "MAGOOD");
  assert.ok(good.result.headers.some(([name]) => name === "content-type"));
  // A cookie the provider sets never reaches the page.
  assert.ok(!good.result.headers.some(([name]) => name === "set-cookie"));

  // What the provider received: the key the page sent, and no cookie.
  const received = session.provider.seen.filter(
    (entry) => entry.method === "GET",
  );
  assert.equal(received.at(-1).headers.authorization, GOOD);
  for (const entry of received) assert.equal(entry.headers.cookie, undefined);
  // The request leaves as a plain client's would: the extension's own origin
  // is not sent, because some providers answer an unknown origin with an error
  // (Helicone a 500, Sanity a 403) where a bad key should get a 401.
  for (const entry of received)
    assert.equal(entry.headers.origin, undefined, "no Origin header");
});

test("a POST leaves without the extension's own origin, as a plain client's would", async (t) => {
  const session = await startSession();
  t.after(() => session.close());
  const state = { browser: null, known: new Set() };
  const tab = await session.context.newPage();
  await tab.goto(`${session.page.origin}/`);
  const popup = await openPopup(session, tab, state);
  await popup.click("[role=switch]");
  await popup.waitFor(
    () =>
      document.querySelector("[role=switch]").getAttribute("aria-checked") ===
      "true",
  );
  await popup.close();
  await tab.reload();
  const reply = await tab.evaluate(
    (body) => window.ask(body),
    fetchOf({
      method: "POST",
      headers: [
        ["authorization", GOOD],
        ["content-type", "application/json"],
      ],
      body: '{"a":1}',
    }),
  );
  assert.equal(reply.ok, true);
  const posted = session.provider.seen.filter(
    (entry) => entry.method === "POST",
  );
  console.log(
    "POST headers at the provider:",
    JSON.stringify(posted.at(-1)?.headers),
  );
  assert.equal(posted.at(-1).headers.origin, undefined, "no Origin header");
});

test("the bridge refuses what it was not asked to carry", async (t) => {
  const session = await startSession();
  t.after(() => session.close());
  const state = { browser: null, known: new Set() };
  const tab = await session.context.newPage();
  await tab.goto(`${session.page.origin}/`);
  const popup = await openPopup(session, tab, state);
  await popup.click("[role=switch]");
  await popup.waitFor(
    () =>
      document.querySelector("[role=switch]").getAttribute("aria-checked") ===
      "true",
  );
  await popup.close();
  await tab.reload();
  const before = session.provider.seen.length;

  const ask = (body) => tab.evaluate((message) => window.ask(message), body);
  for (const [name, body, error] of [
    [
      "a host the table does not name",
      fetchOf({ url: "https://evil.test/" }),
      "host_not_allowed",
    ],
    [
      "another provider's host",
      fetchOf({ providerId: "sendgrid" }),
      "host_not_allowed",
    ],
    [
      "a table host nobody allowed",
      fetchOf({
        providerId: "sendgrid",
        url: "https://api.sendgrid.com/v3/scopes",
      }),
      "not_granted",
    ],
    [
      "a cookie header",
      fetchOf({ headers: [["cookie", "a=b"]] }),
      "denied_header",
    ],
    [
      "plain http",
      fetchOf({ url: "http://api.plivo.com/v1/Account/MA/" }),
      "bad_request",
    ],
    ["a body on a GET", fetchOf({ body: "x" }), "bad_request"],
  ]) {
    const reply = await ask(body);
    assert.equal(reply?.ok, false, name);
    assert.equal(reply.error, error, name);
  }
  assert.equal(
    session.provider.seen.length,
    before,
    "nothing was sent for any of them",
  );

  // A redirect is never followed.
  const redirect = await ask(
    fetchOf({ url: "https://api.plivo.com/redirect" }),
  );
  assert.equal(redirect.ok, false);
  assert.ok(["network", "redirect_refused"].includes(redirect.error));

  // The page may ask for a host; asking allows nothing.
  const need = await ask({
    op: "need",
    hosts: ["api.sendgrid.com", "evil.test"],
  });
  assert.deepEqual(need.result.pending, ["api.sendgrid.com"]);
  assert.equal(
    (
      await ask(
        fetchOf({
          providerId: "sendgrid",
          url: "https://api.sendgrid.com/v3/scopes",
        }),
      )
    ).error,
    "not_granted",
  );
});

test("another origin, and an origin switched off, get no answer", async (t) => {
  const session = await startSession();
  t.after(() => session.close());
  const state = { browser: null, known: new Set() };
  const tab = await session.context.newPage();
  await tab.goto(`${session.page.origin}/`);
  const popup = await openPopup(session, tab, state);
  await popup.click("[role=switch]");
  await popup.waitFor(
    () =>
      document.querySelector("[role=switch]").getAttribute("aria-checked") ===
      "true",
  );
  await popup.close();

  const other = await session.context.newPage();
  await other.goto(`${session.page.origin.replace("127.0.0.1", "localhost")}/`);
  assert.equal(
    await other.evaluate(() => window.ask({ op: "hello" }, 600)),
    null,
  );

  const again = await openPopup(session, tab, state);
  await again.click("[role=switch]");
  await again.waitFor(
    () =>
      document.querySelector("[role=switch]").getAttribute("aria-checked") ===
      "false",
  );
  await again.close();
  const worker = await session.worker();
  const registered = await worker.evaluate(
    async () => (await chrome.scripting.getRegisteredContentScripts()).length,
  );
  assert.equal(registered, 0);
  await tab.reload();
  assert.equal(
    await tab.evaluate(() => window.ask({ op: "hello" }, 600)),
    null,
  );
});
