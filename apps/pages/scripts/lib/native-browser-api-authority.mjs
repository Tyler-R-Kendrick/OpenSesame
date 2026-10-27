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

function expectedHeaders(fixture, resource) {
  const definition = resource ? fixture.read : fixture.preset.verify;
  const headers = Object.fromEntries(
    Object.entries(definition.headers).map(([key, value]) => [
      key.toLowerCase(),
      substitute(value, fixture),
    ]),
  );
  const auth = resource
    ? fixture.preset.auth
    : (fixture.preset.verify.auth ?? fixture.preset.auth);
  if (auth.kind === "header") {
    const value = auth.valueTemplate
      ? substitute(auth.valueTemplate, fixture)
      : fixture.credentials.api_key;
    headers[auth.header.toLowerCase()] = auth.valueTemplate
      ? value
      : auth.scheme
        ? `${auth.scheme} ${value}`
        : value;
  }
  if (auth.kind === "basic")
    headers.authorization = `Basic ${Buffer.from(`${substitute(auth.username, fixture)}:${substitute(auth.password, fixture)}`).toString("base64")}`;
  return headers;
}

function matchesRequest(fixture, request, headers, url, resource) {
  const definition = resource ? fixture.read : fixture.preset.verify;
  if (!definition) return false;
  const payload = definition.body ? substitute(definition.body, fixture) : null;
  const target = resource ? new URL(definition.url) : verificationUrl(fixture);
  return (
    request.method() === definition.method &&
    !headers.cookie &&
    Object.entries(expectedHeaders(fixture, resource)).every(
      ([name, value]) => headers[name] === value,
    ) &&
    (definition.absentHeaders ?? []).every(
      (name) => headers[name] === undefined,
    ) &&
    url.href === target.href &&
    request.postData() === payload
  );
}
function sharedContract(fixture) {
  const read = fixture.read;
  const verify = fixture.preset.verify;
  if (
    !read ||
    read.method !== verify.method ||
    read.url !== verificationUrl(fixture).href ||
    substitute(read.body ?? "", fixture) !==
      substitute(verify.body ?? "", fixture)
  )
    return false;
  const readHeaders = expectedHeaders(fixture, true);
  const verifyHeaders = expectedHeaders(fixture, false);
  return (
    Object.keys(readHeaders).length === Object.keys(verifyHeaders).length &&
    Object.entries(readHeaders).every(
      ([name, value]) => verifyHeaders[name] === value,
    )
  );
}
function matchingRequest(fixture, state, request, headers, url) {
  for (const candidate of [
    fixture,
    ...(state.alternates.get(fixture.providerId) ?? []),
  ]) {
    const verification = matchesRequest(
      candidate,
      request,
      headers,
      url,
      false,
    );
    const resource = matchesRequest(candidate, request, headers, url, true);
    const shared = sharedContract(candidate);
    // A shared route retains the resource contract's stricter absent-header checks.
    if (shared && !resource) continue;
    if (verification || resource)
      return { fixture: candidate, resource, shared };
  }
  return null;
}

function protocolReply(state, fixture, resource) {
  const id = fixture.providerId;
  const status = state.unavailable.has(id)
    ? 503
    : state.reject.has(id)
      ? 401
      : 200;
  const body =
    status === 200
      ? state.malformed.has(id)
        ? "invalid-json"
        : JSON.stringify(resource ? fixture.read.reply : fixture.reply)
      : JSON.stringify({ error: "Synthetic provider refusal" });
  return { status, body };
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
    const match = matchingRequest(fixture, state, request, headers, url);
    if (!match) return route.fallback();
    const matched = match.fixture;
    const definition = match.resource ? matched.read : matched.preset.verify;
    state.calls.push({
      providerId: fixture.providerId,
      // Identical wire contracts cannot reveal which application action sent them.
      purpose: match.resource
        ? match.shared
          ? "shared"
          : "resource"
        : "verification",
      operation: match.resource ? definition.id : null,
      method: request.method(),
      variant: fixture.variant?.id ?? null,
      credentialProof: matched.proof ?? "original protocol credential",
    });
    check(
      request.method() === definition.method,
      `${fixture.providerId}: exact compiled ${match.resource ? "resource" : "verification"} method`,
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
    const { status, body } = protocolReply(state, matched, match.resource);
    if (status >= 400) state.expectedResponses.set(request, status);
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
    const targets = [
      verificationUrl(fixture),
      ...(fixture.read ? [new URL(fixture.read.url)] : []),
    ];
    for (const target of targets) {
      await context.route(
        (url) =>
          url.origin === target.origin && url.pathname === target.pathname,
        providerRoute(fixture, state, check),
      );
    }
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
