/**
 * The questions behind `spec/connectors/oauth-reach.json` (ADR 0218): for a
 * provider whose OAuth application is registered by the person (a confidential
 * client), can a page on the audited origin read the answer of its token,
 * resource and revocation endpoints? An endpoint a page can read is *direct*;
 * one it cannot is carried by the connector bridge (ADR 0199) or not at all.
 *
 * Everything here is pure: the audit script owns the network.
 */

export const ENDPOINTS = ["token", "resource", "revocation"];

const FAKE_REDIRECT = "https://tyler-r-kendrick.github.io/";
const TEMPLATE = /[{}]/;

/** Whether a URL still names a `{placeholder}` a person fills in. */
export function isTemplate(url) {
  return TEMPLATE.test(url);
}

/** The endpoints of a preset worth asking about, each with how it would be called. */
export function endpointsOf(preset) {
  const basic = preset.token_endpoint_auth_method === "client_secret_basic";
  const found = [
    {
      stage: "token",
      url: preset.token_endpoint,
      method: "POST",
      auth: basic ? "basic" : "post",
    },
  ];
  const verify = preset.verify;
  const resource = verify?.url ?? preset.userinfo_endpoint;
  if (resource)
    found.push({
      stage: "resource",
      url: resource,
      method: verify?.url ? (verify.method ?? "GET") : "GET",
      auth: "bearer",
    });
  if (preset.revocation_endpoint)
    found.push({
      stage: "revocation",
      url: preset.revocation_endpoint,
      method: "POST",
      auth: basic ? "basic" : "post",
    });
  return found;
}

/** The request a probe sends. Fake credentials only; nothing is ever granted. */
export function requestFor(endpoint, origin) {
  const headers = { origin, accept: "application/json" };
  let body = null;
  if (endpoint.stage === "resource") {
    headers.authorization = "Bearer probe";
    if (endpoint.method === "POST") {
      headers["content-type"] = "application/json";
      body = "{}";
    }
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams(
      endpoint.stage === "token"
        ? {
            grant_type: "authorization_code",
            code: "probe",
            redirect_uri: FAKE_REDIRECT,
            client_id: "probe",
          }
        : { token: "probe", client_id: "probe" },
    );
    if (endpoint.auth === "basic")
      headers.authorization = "Basic cHJvYmU6cHJvYmU=";
    else form.set("client_secret", "probe");
    body = form.toString();
  }
  return { method: endpoint.method, url: endpoint.url, headers, body };
}

/** The headers a preflight must allow for the request a probe stands for. */
export function preflightNeeds(endpoint) {
  if (endpoint.stage === "resource")
    return endpoint.method === "POST"
      ? ["authorization", "content-type"]
      : ["authorization"];
  return endpoint.auth === "basic" ? ["authorization"] : [];
}

/** A simple POST (form body, no custom header) needs no preflight. */
export function needsPreflight(endpoint) {
  return preflightNeeds(endpoint).length > 0;
}

function allowsOrigin(value, origin) {
  return value === "*" || value === origin;
}

/** `*` does not cover `Authorization`: it has to be named. */
export function allowsHeaders(value, needed) {
  if (needed.length === 0) return true;
  if (!value) return false;
  const listed = value.split(",").map((item) => item.trim().toLowerCase());
  return needed.every((name) => listed.includes(name));
}

/**
 * Whether a page can read this endpoint: the real answer carries an allowing
 * `Access-Control-Allow-Origin`, and where the request needs a preflight that
 * preflight allowed the origin and named the headers.
 */
export function isDirect(endpoint, actual, preflight, origin) {
  if (!allowsOrigin(actual.allow_origin, origin)) return false;
  if (!needsPreflight(endpoint)) return true;
  // A browser rejects a preflight that is not a success, whatever headers it carries.
  return (
    !!preflight &&
    preflight.status >= 200 &&
    preflight.status < 300 &&
    allowsOrigin(preflight.allow_origin, origin) &&
    allowsHeaders(preflight.allow_headers, preflightNeeds(endpoint))
  );
}

/** What a recorded answer says, with only the headers that decide it. */
export function observe(status, headers) {
  const get = (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value.join(", ") : (value ?? null);
  };
  return {
    status,
    allow_origin: get("access-control-allow-origin"),
    allow_headers: get("access-control-allow-headers"),
  };
}

/** The literal host of a URL that names no placeholder. */
export function hostOf(url) {
  if (isTemplate(url)) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** A recorded endpoint that moved: its direct/bridge verdict differs from the one now observed. */
export function moved(recorded, direct) {
  return recorded.direct === direct
    ? null
    : `was ${recorded.direct ? "direct" : "refused"}, now ${direct ? "direct" : "refused"}`;
}
