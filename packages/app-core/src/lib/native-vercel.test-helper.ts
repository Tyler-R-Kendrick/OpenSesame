import type { NativePending } from "./native-connector-schema.js";

export const vercelPending = (): NativePending => ({
  providerId: "vercel",
  actor: "user",
  fingerprint: "a".repeat(64),
  issuer: "https://vercel.com",
  endpoint: "https://api.vercel.com/login/oauth/token",
  clientId: "public-spa-client",
  state: "s".repeat(43),
  verifier: "v".repeat(43),
  redirectUri: "https://selfhost.example/auth/native-connector.html",
  createdAt: Date.now(),
  expiresAt: Date.now() + 600_000,
  scopes: ["openid", "email", "profile"],
});
