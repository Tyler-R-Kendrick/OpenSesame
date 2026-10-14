/** Native partner presets spend their configured credentials through shared adapters. */
import { expect } from "@playwright/test";
import { PIN, unlockWithPin } from "./pages-journey.mjs";

export async function extraNativeFlows({
  page,
  width,
  better,
  supabase,
  configured,
  save,
  snapshot,
  check,
}) {
  for (const provider of ["neon-auth", "supabase"]) {
    const neon = provider === "neon-auth";
    const target = neon ? better : supabase;
    const name = neon
      ? `Neon protocol fixture ${width}`
      : `GoTrue protocol fixture ${width}`;
    await configured(page, provider);
    await page.getByLabel("Connection name", { exact: true }).fill(name);
    await page
      .getByLabel(neon ? "Auth API base URL" : "Project URL", { exact: true })
      .fill(neon ? better.baseUrl : supabase.origin);
    if (!neon)
      await page
        .getByLabel("Publishable / anon key", { exact: true })
        .fill(supabase.publicKey);
    await save(page);
    await page
      .getByLabel("Email address", { exact: true })
      .fill(target.credentials.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(target.credentials.password);
    await page
      .getByRole("button", { name: `Sign in to ${name}`, exact: true })
      .click();
    await expect(
      page.getByRole("img", { name: "Signed in", exact: true }).first(),
    ).toBeVisible();
    check(
      true,
      `${width}: ${provider} preset signs in using real HTTP + signed JWT verification (local protocol fixture)`,
    );
    const jwksPath = neon
      ? "/api/auth/.well-known/jwks.json"
      : "/auth/v1/.well-known/jwks.json";
    check(
      target.requests.some((request) => request.path === jwksPath),
      `${width}: ${provider} discovers the documented signing-key path`,
    );
    if (!neon) {
      for (const endpoint of [
        "/auth/v1/settings",
        "/auth/v1/token",
        "/auth/v1/user",
      ])
        check(
          supabase.requests.some(
            (request) => request.path === endpoint && request.publicKeyValid,
          ),
          `${width}: GoTrue socket ${endpoint} received the configured public key`,
        );
    }
    await snapshot(page, `${width}-${provider}-signed-in`);
    const sessionPath = neon ? "/api/auth/get-session" : "/auth/v1/user";
    const beforeReload = target.requests.filter(
      (request) => request.path === sessionPath,
    ).length;
    await page.reload({ waitUntil: "networkidle" });
    await unlockWithPin(page);
    await configured(page, provider);
    await expect(
      page.getByRole("img", { name: "Connected", exact: true }).first(),
    ).toBeVisible();
    check(
      target.requests.filter((request) => request.path === sessionPath).length >
        beforeReload,
      `${width}: ${provider} cold boot revalidates the real provider session before restoring identity`,
    );
    await page
      .getByRole("button", { name: "Remove identity connection", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Confirm remove identity connection",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("region", { name: "Identity sign-in", exact: true }),
    ).toHaveCount(0);
    check(
      target.requests.some(
        (request) =>
          request.path === (neon ? "/api/auth/sign-out" : "/auth/v1/logout"),
      ),
      `${width}: ${provider} removal revokes its upstream session`,
    );
  }
}

export { allowLoopbackDevelopment } from "./local-network-permission.mjs";

/** A fresh root load must authenticate from saved native configuration without Settings. */
export async function coldNativeSignIn({
  page,
  origin,
  base,
  width,
  better,
  check,
  waitOpen,
}) {
  await page
    .getByRole("button", { name: "Lock vault", exact: true })
    .locator("visible=true")
    .first()
    .click();
  await page.getByRole("button", { name: /^Signed in as / }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  const provider = page.getByRole("button", {
    name: `Continue with Real Better Auth ${width}`,
    exact: true,
  });
  await provider.waitFor();
  const before = better.requests.filter(
    (request) => request.path === "/api/auth/sign-in/email",
  ).length;
  await provider.click();
  await page
    .getByLabel("Email address", { exact: true })
    .fill(better.credentials.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(better.credentials.password);
  await page
    .getByRole("button", {
      name: `Sign in to Real Better Auth ${width}`,
      exact: true,
    })
    .click();
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
  check(
    better.requests.filter(
      (request) => request.path === "/api/auth/sign-in/email",
    ).length ===
      before + 1,
    `${width}: cold root sign-in hydrates saved native configuration and authenticates without loading Settings`,
  );
}
