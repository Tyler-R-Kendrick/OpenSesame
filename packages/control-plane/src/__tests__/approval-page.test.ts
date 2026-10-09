import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

it("serves an inert, non-framable hosted review while keeping request APIs authenticated", async () => {
  const { app } = createControlPlane();
  const page = await app.request("/v1/approval/ceremony");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(page.headers.get("content-security-policy")).not.toContain(
    "unsafe-inline",
  );
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(await page.text()).toContain('type="button" disabled');
  const script = await app.request("/v1/approval/ceremony.js");
  expect(script.headers.get("content-type")).toContain("text/javascript");
  const code = await script.text();
  expect(code).toContain('credentials:"same-origin"');
  expect(code).not.toContain("postMessage");
  expect(code).not.toContain("innerHTML");
  for (const suffix of [
    "",
    "/requirement",
    "/activation",
    "/activation/complete",
    "/approve",
    "/deny",
  ]) {
    const response = await app.request(
      `/v1/authorization-requests/areq_other${suffix}`,
      {
        method: ["", "/requirement"].includes(suffix) ? "GET" : "POST",
      },
    );
    expect(response.status).toBe(401);
  }
});
