/** Validate provider handoff data before displaying it on a terminal. */
interface BoatHandoffInput {
  verificationUri: string;
  userCode?: string;
}

interface BoatHandoff {
  url: string;
  userCode?: string;
}

function parseHandoffUrl(value: string): URL {
  if (
    value.length === 0 ||
    value.length > 8192 ||
    !/^[\x21-\x7e]+$/u.test(value)
  )
    throw new Error("Boat returned an invalid human handoff URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Boat returned an invalid human handoff URL");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Boat returned an invalid human handoff URL");
  return url;
}

function claimHandoff(url: URL, userCode: string | undefined): BoatHandoff {
  const attempts = url.searchParams.getAll("claim_attempt_token");
  if (
    url.pathname !== "/api/boat/agent/identity/claim" ||
    url.hash ||
    attempts.length !== 1 ||
    !attempts[0] ||
    !userCode ||
    !/^[0-9]{6}$/u.test(userCode)
  )
    throw new Error("Boat returned an invalid claim handoff");
  return { url: url.href, userCode };
}

/** Claim links use Boat's endpoint; billing uses hosted Stripe Checkout. */
export function boatClaimHandoff(input: BoatHandoffInput): BoatHandoff {
  const url = parseHandoffUrl(input.verificationUri);
  if (url.origin === "https://boat.dev")
    return claimHandoff(url, input.userCode);
  if (
    url.origin === "https://checkout.stripe.com" &&
    input.userCode === undefined
  )
    return { url: url.href };
  throw new Error("Boat returned an untrusted human handoff URL");
}

/**
 * A temporary Cloudflare account is claimed on the dashboard claim
 * page with exactly one claim token and no user code.
 */
export function cloudflareClaimHandoff(input: BoatHandoffInput): BoatHandoff {
  const url = parseHandoffUrl(input.verificationUri);
  const tokens = url.searchParams.getAll("claimToken");
  if (
    url.origin !== "https://dash.cloudflare.com" ||
    url.pathname !== "/claim-preview" ||
    url.hash ||
    tokens.length !== 1 ||
    !tokens[0] ||
    input.userCode !== undefined
  )
    throw new Error("Cloudflare returned an invalid claim handoff");
  return { url: url.href };
}
