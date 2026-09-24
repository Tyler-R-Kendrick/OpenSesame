import { overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { publicAuthenticationCors } from "../middleware/public-auth-cors.js";

function app(state = "active") {
  const instance = new Hono();
  instance.use(
    "*",
    publicAuthenticationCors(
      overlapCast({
        authenticationStores: {
          applications: {
            get: async (id: string) =>
              id === "authapp_one"
                ? { state, origins: ["https://rp.example"] }
                : undefined,
          },
        },
      }),
    ),
  );
  instance.post("*", (c) => c.json({ ok: true }));
  return instance;
}
const path =
  "/v1/authentication/public/applications/authapp_one/signin/options";
const headers = {
  Origin: "https://rp.example",
  "Access-Control-Request-Method": "POST",
  "Access-Control-Request-Headers": "content-type",
  "Access-Control-Request-Private-Network": "true",
};

describe("application-bound public authentication CORS", () => {
  it("admits only registered application origins without cookies or PNA", async () => {
    const response = await app().request(path, { method: "OPTIONS", headers });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://rp.example",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type",
    );
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(
      false,
    );
    expect(response.headers.has("Access-Control-Allow-Private-Network")).toBe(
      false,
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });
  it.each(["https://evil.example", "null", "*", ""])(
    "denies origin %j",
    async (Origin) => {
      const response = await app().request(path, {
        method: "OPTIONS",
        headers: { ...headers, Origin },
      });
      expect(response.status).toBe(404);
      expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    },
  );
  it("denies inactive applications, cross-application bodies and privileged headers", async () => {
    expect(
      (await app("inactive").request(path, { method: "OPTIONS", headers }))
        .status,
    ).toBe(404);
    expect(
      (
        await app().request(path, {
          method: "OPTIONS",
          headers: {
            ...headers,
            "Access-Control-Request-Headers": "authorization",
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app().request(path, {
          method: "POST",
          headers: {
            Origin: headers.Origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ applicationId: "authapp_other" }),
        })
      ).status,
    ).toBe(400);
  });
  it("retires the body-only surface without permissive CORS", async () => {
    const response = await app().request(
      "/v1/authentication/public/signin/options",
      { method: "OPTIONS", headers },
    );
    expect(response.status).toBe(410);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });
  it.each([null, "authapp_one", 42, [], {}, { applicationId: 42 }])(
    "refuses malformed application envelope %j without CORS admission",
    async (body) => {
      const response = await app().request(path, {
        method: "POST",
        headers: { Origin: headers.Origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    },
  );
  it("admits the exact application body without credentialed CORS", async () => {
    const response = await app().request(path, {
      method: "POST",
      headers: { Origin: headers.Origin, "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId: "authapp_one" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      headers.Origin,
    );
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(
      false,
    );
  });
});
