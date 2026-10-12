import assert from "node:assert/strict";
import fs from "node:fs";
import { requestJson } from "../../../scripts/test/provider-auth-services.mjs";
/** Actual browser provider HTTP observations; bearer values remain private memory. */
export function observeProviderAuth(context, { services, idp, site }) {
  const serviceByOrigin = new Map(
    Object.values(services).map((service) => [service.endpoint, service]),
  );
  const grantServices = new Map();
  const errors = [];
  const grants = [];
  const exchanges = [];
  const successfulExchanges = [];
  const callbacks = [];
  const providerStates = [];
  const httpFailures = [];
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      httpFailures.push(
        `${url.origin}${url.pathname}: ${request.failure()?.errorText}`,
      );
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      const service = serviceByOrigin.get(url.origin);
      if (url.origin === site.origin && url.searchParams.has("code"))
        callbacks.push(url.href);
      if (
        service &&
        request.method() === "GET" &&
        url.pathname.endsWith("/oidc/callback")
      )
        exchanges.push(request);
      if (
        service &&
        request.method() === "GET" &&
        url.pathname === "/v1/auth/token/lookup-self"
      ) {
        // Bounded production response readers cancel streams after consumption,
        // so CDP cannot reread their bodies. The subsequent genuine provider
        // request carries the issued bearer and is independently validated.
        const token = request.headers()["x-vault-token"];
        if (token && !grantServices.has(token)) {
          grants.push(token);
          grantServices.set(token, service);
        }
      }
      if (url.origin === idp.issuer && url.searchParams.has("state"))
        providerStates.push(url.searchParams.get("state"));
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (response.status() >= 400)
        httpFailures.push(
          `${url.origin}${url.pathname}: HTTP ${response.status()}`,
        );
      if (
        serviceByOrigin.has(url.origin) &&
        response.request().method() === "GET" &&
        url.pathname.endsWith("/oidc/callback") &&
        response.status() === 200
      )
        successfulExchanges.push(response);
    });
  });
  return {
    settleResponses() {
      assert.equal(
        successfulExchanges.length,
        exchanges.length,
        "Every real code exchange must return provider success",
      );
      assert.equal(
        grants.length,
        successfulExchanges.length,
        "Every actual successful exchange must issue a bearer used for provider lookup",
      );
    },
    errors,
    grants,
    exchanges,
    callbacks,
    providerStates,
    grantServices,
    httpFailures,
  };
}

export async function validateIssuedProviderGrants({ grants, grantServices }) {
  for (const token of grants) {
    const service = grantServices.get(token);
    assert.ok(service, "Observed bearer belongs to an actual provider origin");
    const lookup = await requestJson(
      `${service.endpoint}/v1/auth/token/lookup-self`,
      { ca: service.ca, token },
    );
    assert.equal(
      lookup.status,
      200,
      "Actual provider accepts its OIDC-issued browser bearer",
    );
    assert.ok(
      Boolean(lookup.body.data.entity_id),
      "Actual provider binds the issuer identity",
    );
    assert.ok(
      lookup.body.data.policies.includes("browser-read") &&
        !lookup.body.data.policies.includes("root"),
      "Actual issued bearer uses the provider's restricted policy",
    );
  }
}

export async function saveProviderFailure({
  page,
  out,
  label,
  step,
  error,
  observed,
}) {
  fs.writeFileSync(
    `${out}/${label}-failure.txt`,
    `${step}\n${error.message}\n${JSON.stringify(observed.httpFailures)}\n${await page.locator("body").innerText()}`,
    { mode: 0o600 },
  );
  await page.bringToFront();
  await page
    .screenshot({
      path: `${out}/${label}-failure.png`,
      fullPage: false,
      animations: "disabled",
      timeout: 5000,
    })
    .catch(() => undefined);
}
