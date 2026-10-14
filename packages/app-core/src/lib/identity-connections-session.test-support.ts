import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { vi } from "vitest";
import { identityConnectionDraft } from "./identity-connections-presets.js";
import { identitySessionIssuer } from "./identity-connections-session.js";
export const email = "identity@example.com";
export const password = "correct-horse-battery-staple";
export async function betterAuthFixture() {
  const baseURL = "https://identity.example.com";
  const auth = betterAuth({
    baseURL,
    secret: "test-better-auth-secret-with-32-characters",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [jwt()],
    logger: { disabled: true },
  });
  await auth.api.signUpEmail({
    body: { email, password, name: "Identity User" },
  });
  let cookie = "";
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      const headers = new Headers(init.headers);
      if (init.credentials === "include" && cookie)
        headers.set("Cookie", cookie);
      const response = await auth.handler(
        new Request(url, { ...init, headers }),
      );
      if (init.credentials === "include") {
        const cookies = response.headers.getSetCookie();
        if (cookies.length)
          cookie = cookies.map((value) => value.split(";")[0]).join("; ");
      }
      return response;
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock, baseURL };
}

type SupabaseFixtureOptions = {
  subject?: string;
  expired?: boolean;
  legacy?: boolean;
};
export async function supabaseFixture(options: SupabaseFixtureOptions = {}) {
  const draft = {
    ...identityConnectionDraft("supabase"),
    baseUrl: "https://project.supabase.co",
    publicKey: "sb_publishable_browser-key",
  };
  const keys = await generateKeyPair("ES256");
  const secret = new TextEncoder().encode(
    "test-supabase-legacy-secret-32-characters",
  );
  const token = await new SignJWT({ email })
    .setProtectedHeader({
      alg: options.legacy ? "HS256" : "ES256",
      kid: "test-key",
    })
    .setIssuer(identitySessionIssuer(draft))
    .setAudience("authenticated")
    .setSubject("supabase-user")
    .setExpirationTime(
      options.expired ? Math.floor(Date.now() / 1000) - 10 : "15m",
    )
    .sign(options.legacy ? secret : keys.privateKey);
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    requests.push({ url: input, init });
    if (input.endsWith("/settings"))
      return Response.json({ external: { email: true } });
    if (input.endsWith("/token?grant_type=password"))
      return Response.json({ access_token: token });
    if (input.endsWith("/user"))
      return Response.json({ id: options.subject ?? "supabase-user", email });
    if (input.endsWith("/.well-known/jwks.json"))
      return Response.json({
        keys: [
          {
            ...(await exportJWK(keys.publicKey)),
            alg: "ES256",
            kid: "test-key",
          },
        ],
      });
    if (input.endsWith("/logout?scope=local"))
      return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { draft, requests, token };
}
