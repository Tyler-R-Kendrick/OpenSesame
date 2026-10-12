/**
 * Re-probing the evidence behind `spec/connectors/browser-dispositions.json`
 * (ADR 0197). Pure: it builds the request a recorded probe describes, reads
 * the answer, and says whether the answer still agrees with what was
 * recorded. The network belongs to `scripts/audit/browser-disposition-probes.mjs`.
 */

/** Does an `Access-Control-Allow-Origin` value let this origin read the response? */
export function admits(allowOrigin, origin) {
  return allowOrigin === "*" || allowOrigin === origin;
}

/** The request a recorded probe describes, made from the audited origin unless it records another. */
export function requestFor(probe, auditedOrigin) {
  const origin = probe.origin ?? auditedOrigin;
  if (probe.stage === "preflight")
    return {
      method: "OPTIONS",
      url: probe.url,
      headers: {
        origin,
        "access-control-request-method": probe.method,
        "access-control-request-headers": probe.request_header_names.join(","),
      },
    };
  if (probe.stage === "unauthenticated-get")
    return {
      method: "GET",
      url: probe.url,
      headers: { origin, accept: "application/json" },
    };
  throw new Error(`Unknown probe stage: ${probe.stage}`);
}

/** What a response says about browser access, in the recorded shape. */
export function observe(status, headers) {
  const header = (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value.join(", ") : (value ?? null);
  };
  return {
    status,
    allow_origin: header("access-control-allow-origin"),
    allow_methods: header("access-control-allow-methods"),
    allow_headers: header("access-control-allow-headers"),
  };
}

/**
 * How a fresh answer differs from the recorded one, in words; `null` when they
 * still agree. Only what a claim rests on is compared: the status, and whether
 * the origin is admitted. A changed allow-list of methods or headers is not
 * drift in the claim.
 */
export function drift(recorded, observed, auditedOrigin) {
  const origin = recorded.origin ?? auditedOrigin;
  if (recorded.status !== observed.status)
    return `status ${recorded.status} -> ${observed.status}`;
  const was = admits(recorded.allow_origin, origin);
  const now = admits(observed.allow_origin, origin);
  if (was !== now)
    return now
      ? "now admits the origin (recorded: it did not)"
      : "no longer admits the origin (recorded: it did)";
  return null;
}
