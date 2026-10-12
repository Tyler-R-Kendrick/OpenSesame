/** Fixed provider HTTP test authority. It changes no application code or state. */
import {
  nativeApiFixture,
  nativeBrowserPlans,
} from "./native-browser-provider-fixtures.mjs";

function substitute(value, fixture) {
  const values = {
    ...fixture.parameters,
    ...fixture.credentials,
    key: fixture.credentials.api_key,
  };
  return value.replace(/\{([a-z_]+)\}/g, (_match, field) => {
    if (values[field] === undefined)
      throw new Error(`Missing protocol fixture field ${field}.`);
    return values[field];
  });
}

function verificationUrl(fixture) {
  const url = new URL(substitute(fixture.preset.verify.url, fixture));
  const auth = fixture.preset.verify.auth ?? fixture.preset.auth;
  if (auth.kind === "query")
    url.searchParams.set(auth.parameter, fixture.credentials.api_key);
  return url;
}

function expectedHeaders(fixture) {
  const headers = Object.fromEntries(
    Object.entries(fixture.preset.verify.headers).map(([key, value]) => [
      key.toLowerCase(),
      substitute(value, fixture),
    ]),
  );
  const auth = fixture.preset.verify.auth ?? fixture.preset.auth;
  if (auth.kind === "header") {
    const value = auth.valueTemplate
      ? substitute(auth.valueTemplate, fixture)
      : fixture.credentials.api_key;
    headers[auth.header.toLowerCase()] = auth.scheme
      ? `${auth.scheme} ${value}`
      : value;
  }
  if (auth.kind === "basic")
    headers.authorization = `Basic ${Buffer.from(`${substitute(auth.username, fixture)}:${substitute(auth.password, fixture)}`).toString("base64")}`;
  return headers;
}

function matchesRequest(fixture, request, headers, url) {
  const payload = fixture.preset.verify.body
    ? substitute(fixture.preset.verify.body, fixture)
    : null;
  return (
    Object.entries(expectedHeaders(fixture)).every(
      ([name, value]) => headers[name] === value,
    ) &&
    url.href === verificationUrl(fixture).href &&
    (payload === null || request.postData() === payload)
  );
}

function providerRoute(fixture, state, check) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST",
          "access-control-allow-headers": "*",
        },
      });
    const headers = await request.allHeaders();
    const matched = [
      fixture,
      ...(state.alternates.get(fixture.providerId) ?? []),
    ].find((candidate) => matchesRequest(candidate, request, headers, url));
    if (!matched) return route.fallback();
    state.calls.push({
      providerId: fixture.providerId,
      method: request.method(),
      variant: fixture.variant?.id ?? null,
      credentialProof: matched.proof ?? "original protocol credential",
    });
    check(
      request.method() === fixture.preset.verify.method,
      `${fixture.providerId}: exact compiled verification method`,
    );
    check(
      !headers.cookie,
      `${fixture.providerId}: credential verification sends no cookies`,
    );
    if (fixture.preset.verify.body)
      check(
        request.postData() === substitute(fixture.preset.verify.body, fixture),
        `${fixture.providerId}: exact provider verification payload`,
      );
    const pause = state.pauses.get(fixture.providerId);
    if (pause) await pause;
    const status = state.unavailable.has(fixture.providerId)
      ? 503
      : state.reject.has(fixture.providerId)
        ? 401
        : 200;
    if (status >= 400) state.expectedResponses.set(request, status);
    const body =
      status === 200
        ? state.malformed.has(fixture.providerId)
          ? "invalid-json"
          : JSON.stringify(matched.reply)
        : JSON.stringify({ error: "Synthetic provider refusal" });
    return route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body,
    });
  };
}

export async function routeNativeApiAuthority(context, { check }) {
  const fixtures = nativeBrowserPlans()
    .filter((plan) => !plan.refused)
    .flatMap((plan) => {
      const base = nativeApiFixture(plan);
      if (!base) return [];
      const variants = base.preset.credentialVariants;
      return variants.length
        ? variants.map((variant) => nativeApiFixture(plan, variant.id))
        : [base];
    });
  const state = {
    calls: [],
    reject: new Set(),
    unavailable: new Set(),
    malformed: new Set(),
    expectedResponses: new WeakMap(),
    expectedDocuments: new Set(),
    alternates: new Map(),
    pauses: new Map(),
  };
  for (const fixture of fixtures) {
    const target = verificationUrl(fixture);
    await context.route(
      (url) => url.origin === target.origin && url.pathname === target.pathname,
      providerRoute(fixture, state, check),
    );
  }
  return {
    state,
    fixtures,
    alternate(fixture, proof) {
      const next = {
        ...fixture,
        proof,
        credentials: {
          ...fixture.credentials,
          api_key: `${fixture.credentials.api_key}-${proof}`,
        },
      };
      state.alternates.set(fixture.providerId, [
        ...(state.alternates.get(fixture.providerId) ?? []),
        next,
      ]);
      return next;
    },
    pause(providerId) {
      let release;
      state.pauses.set(
        providerId,
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        state.pauses.delete(providerId);
        release();
      };
    },
  };
}
