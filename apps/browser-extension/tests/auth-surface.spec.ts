import { test, expect } from "@playwright/test";

/**
 * Extension auth.md discovery smoke — runs against a local gateway.
 * Start gateway before CI job; baseURL from PLAYWRIGHT_BASE_URL.
 */
test.describe("opensesame extension surface", () => {
  test("auth.md advertises connection-oriented invoke", async ({ request }) => {
    const base = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:18787";
    const res = await request.get(`${base}/auth.md`);
    expect(res.ok()).toBeTruthy();
    const body = await res.text();
    expect(body).toMatch(/connection_ref/i);
    expect(body.toLowerCase()).toContain("never secretref");
    expect(body.toLowerCase()).not.toMatch(/secretref protocol|use secretref/i);
  });

  test("connections endpoint returns connection_ref only", async ({ request }) => {
    const base = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:18787";
    const op = process.env.OPENSESAME_OPERATOR_TOKEN || "opensesame-dev-operator";
    const res = await request.get(`${base}/api/v1/connections`, {
      headers: { "x-opensesame-operator": op },
    });
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.connections[0].connection_ref).toMatch(/^conn:\/\//);
    expect(JSON.stringify(json)).not.toMatch(/secret:\/\//);
  });
});
