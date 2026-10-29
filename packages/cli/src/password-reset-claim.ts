/**
 * Validate the human-facing Boat handoff before displaying provider data on
 * a terminal. Claim links use Boat's documented claim endpoint; billing links
 * use hosted Stripe Checkout. No link is opened automatically.
 */
export function boatClaimHandoff(input: {
  verificationUri: string;
  userCode?: string;
}): { url: string; userCode?: string } {
  const { verificationUri, userCode } = input;
  if (
    verificationUri.length === 0 ||
    verificationUri.length > 8192 ||
    !/^[\x21-\x7e]+$/u.test(verificationUri)
  )
    throw new Error("Boat returned an invalid human handoff URL");
  let url: URL;
  try {
    url = new URL(verificationUri);
  } catch {
    throw new Error("Boat returned an invalid human handoff URL");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Boat returned an invalid human handoff URL");
  if (url.origin === "https://boat.dev") {
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
  if (url.origin === "https://checkout.stripe.com" && userCode === undefined)
    return { url: url.href };
  throw new Error("Boat returned an untrusted human handoff URL");
}
