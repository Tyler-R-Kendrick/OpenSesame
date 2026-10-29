import { describe, expect, it } from "vitest";
import type { VirtualFetch, VirtualFetchRequest } from "./vnet.js";
import { WasmDomDriver } from "./wasm-dom-driver.js";

const FORM_PAGE = `<!doctype html><html><body>
  <form method="post" action="/reset/submit">
    <label>Email <input name="email" type="email"></label>
    <label>New password <input name="password" type="password"></label>
    <button>Save password</button>
  </form>
</body></html>`;

type RecordedRequest = { url: string; method: string; body?: string };

function memoryFetch(pageEntries: ReadonlyArray<readonly [string, string]>) {
  const pages = new Map(pageEntries);
  const requests: RecordedRequest[] = [];
  return {
    requests,
    virtualFetch: async (request: VirtualFetchRequest) => {
      const recorded: RecordedRequest = {
        url: request.url,
        method: request.method,
      };
      if (request.body !== undefined) recorded.body = request.body;
      requests.push(recorded);
      const page = pages.get(new URL(request.url).pathname);
      return {
        status: page ? 200 : 404,
        url: request.url,
        headers: {},
        bodyText: page ?? "<html><body>missing</body></html>",
      };
    },
  };
}

function driverFor(virtualFetch: VirtualFetch): WasmDomDriver {
  return new WasmDomDriver({
    virtualFetch,
    sessionId: "test-session",
    allowedDomains: ["accounts.example.test"],
  });
}

describe("WasmDomDriver", () => {
  it("snapshots form fields with labels and kinds", async () => {
    const { virtualFetch } = memoryFetch([["/reset", FORM_PAGE]]);
    const driver = driverFor(virtualFetch);
    await driver.open("https://accounts.example.test/reset");
    const snapshot = await driver.snapshot();
    expect(snapshot.origin).toBe("https://accounts.example.test");
    expect(snapshot.fields).toEqual([
      { ref: "e1", kind: "email", label: "Email" },
      { ref: "e2", kind: "password", label: "New password" },
      { ref: "e3", kind: "button", label: "Save password" },
    ]);
  });

  it("fills and submits a form through the virtual network only", async () => {
    const { virtualFetch, requests } = memoryFetch([
      ["/reset", FORM_PAGE],
      ["/reset/submit", "<html><body>Password updated</body></html>"],
    ]);
    const driver = driverFor(virtualFetch);
    await driver.open("https://accounts.example.test/reset");
    await driver.fill("e1", "person@example.test");
    await driver.fillSecret("e2", "candidate-pepper-value");
    await driver.click("e3");
    const submission = requests.find((r) => r.method === "POST");
    expect(submission?.url).toBe("https://accounts.example.test/reset/submit");
    expect(submission?.body).toContain("email=person%40example.test");
    expect(submission?.body).toContain("password=candidate-pepper-value");
    expect(await driver.pageUrl()).toContain("/reset/submit");
    // The secret never appears in an observation.
    expect(JSON.stringify(await driver.snapshot())).not.toContain(
      "candidate-pepper-value",
    );
  });

  it("surfaces an active challenge as static, but not branding", async () => {
    const { virtualFetch } = memoryFetch([
      [
        "/reset",
        "<html><body><p>CAPTCHA verify you are human</p><p>This site is protected by reCAPTCHA</p></body></html>",
      ],
      [
        "/plain",
        "<html><body><p>This site is protected by reCAPTCHA</p></body></html>",
      ],
    ]);
    const driver = driverFor(virtualFetch);
    await driver.open("https://accounts.example.test/reset");
    expect((await driver.snapshot()).fields).toContainEqual({
      ref: "e1",
      kind: "static",
      label: "CAPTCHA verify you are human",
    });
    await driver.open("https://accounts.example.test/plain");
    expect((await driver.snapshot()).fields).toEqual([]);
  });

  it("refuses navigation outside the allowlist", async () => {
    const { virtualFetch } = memoryFetch([]);
    const driver = driverFor(virtualFetch);
    await expect(driver.open("https://evil.example.test/")).rejects.toThrow(
      "approved domains",
    );
  });
});
