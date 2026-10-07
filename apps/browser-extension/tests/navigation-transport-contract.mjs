/** Real network counters exercise transport only, never extension admission. */
import assert from "node:assert/strict";
import http from "node:http";
import { controlWorkflowNavigation } from "./controlled-navigation.mjs";

const controlledBody =
  "Controlled navigation endpoint; no vault or credentials.";
const ordinaryBody = "Unmodified local transport control.";
const document = (body) =>
  `<html><head><link rel="icon" href="data:,"></head><body>${body}</body></html>`;

async function createdPage(context, create, expected, body) {
  const opened = context.waitForEvent("page", { timeout: 5000 });
  const [page] = await Promise.all([opened, create()]);
  await page.waitForURL(expected, { timeout: 5000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
  assert.equal(await page.locator("body").innerText(), body);
  return page;
}

export async function proveNavigationTransport(context, profile) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("Content-Type", "text/html");
    response.end(document(ordinaryBody));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const destination = `${origin}/OpenSesame/`;
  const expected = `${destination}vault?workflow=password`;
  const pages = [];
  let navigation;
  let browserSession;
  try {
    navigation = await controlWorkflowNavigation(profile, destination);
    browserSession = await context.browser().newBrowserCDPSession();
    pages.push(
      await createdPage(
        context,
        () => browserSession.send("Target.createTarget", { url: expected }),
        expected,
        controlledBody,
      ),
    );
    assert.deepEqual(
      requests,
      [],
      "Native initial document never hit the server",
    );
    assert.deepEqual(navigation.reached, [expected]);
    pages.push(
      await createdPage(
        context,
        () => pages[0].evaluate((url) => window.open(url, "_blank"), expected),
        expected,
        controlledBody,
      ),
    );
    assert.deepEqual(requests, [], "Renderer document never hit the server");
    assert.deepEqual(navigation.reached, [expected, expected]);
    const ordinary = `${origin}/unrelated`;
    pages.push(
      await createdPage(
        context,
        () => browserSession.send("Target.createTarget", { url: ordinary }),
        ordinary,
        ordinaryBody,
      ),
    );
    assert.deepEqual(
      requests,
      ["/unrelated"],
      "Nonmatching traffic is unchanged",
    );
    assert.deepEqual(navigation.reached, [expected, expected]);
    assert.deepEqual(navigation.errors, []);
  } finally {
    for (const page of pages) await page.close();
    await navigation?.close();
    await browserSession?.detach();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
