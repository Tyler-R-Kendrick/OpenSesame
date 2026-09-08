import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  decodeJwtEnvelope,
  randomString,
  sha256Base64Url,
} from "@opensesame/sdk-browser";
import {
  endpoint,
  exactOrigin,
  fetchJson,
  isLoopbackOrigin,
} from "./transport.js";

export type LoopbackProfile = {
  profile: "pages_passthrough_loopback";
  brokerBase: string;
  /** Pinned by the RP, never read from the broker response. */
  issuer: "https://shoo.dev";
  audience: string;
};

function validateProfile(profile: LoopbackProfile, rpOrigin: string) {
  if (
    !isLoopbackOrigin(rpOrigin) ||
    profile.profile !== "pages_passthrough_loopback" ||
    profile.issuer !== "https://shoo.dev"
  )
    throw new Error("unsupported_profile");
  const broker = new URL(endpoint(profile.brokerBase));
  if (profile.audience !== `origin:${broker.origin}`)
    throw new Error("invalid_audience_configuration");
}

export async function validateLoopbackToken(
  token: string,
  profile: LoopbackProfile,
  rpOrigin: string,
) {
  validateProfile(profile, rpOrigin);
  if (token.length > 16384 || token.split(".").length !== 3)
    throw new Error("invalid_token");
  const { header, claims } = decodeJwtEnvelope(token);
  const pairwiseSub = overlapCast<unknown, BoundaryValue>(claims.pairwise_sub);
  const now = Math.floor(Date.now() / 1000);
  if (
    header.alg !== "ES256" ||
    header.typ !== "JWT" ||
    header.crit ||
    header.jku ||
    header.jwk
  )
    throw new Error("invalid_token");
  if (claims.iss !== profile.issuer || claims.aud !== profile.audience)
    throw new Error("invalid_token");
  validateClaimTimes(claims, now);
  if (!isString(pairwiseSub) || !pairwiseSub || pairwiseSub.length > 512)
    throw new Error("invalid_token");
  const checked = await fetchJson("https://shoo.dev/session/check", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (
    checked.status !== "active" ||
    claims.exp <= Math.floor(Date.now() / 1000)
  )
    throw new Error("inactive_session");
  return {
    subject: await sha256Base64Url(`${pairwiseSub}:${rpOrigin}`),
    expiresAt: claims.exp * 1000,
  };
}

/** Tokens remain in the validator; events expose only the validated RP subject. */
export function signInLoopback(
  profile: LoopbackProfile,
  browser: Window = window,
) {
  const rpOrigin = exactOrigin(browser.location.origin);
  if (!isLoopbackOrigin(rpOrigin))
    return Promise.reject(new Error("loopback_only"));
  const base = endpoint(profile.brokerBase);
  const brokerOrigin = new URL(base).origin;
  const state = randomString(24);
  const createdAt = Date.now();
  const url = new URL(
    "broker/authorize",
    base.endsWith("/") ? base : `${base}/`,
  );
  url.search = new URLSearchParams({
    profile: profile.profile,
    origin: rpOrigin,
    client_id: `origin:${rpOrigin}`,
    scope: "openid",
    state,
  }).toString();
  return new Promise<{ subject: string; expiresAt: number }>(
    (resolve, reject) => {
      const popup = browser.open(
        url,
        `opensesame-${state}`,
        "popup=yes,width=480,height=720",
      );
      if (!popup) {
        reject(new Error("popup_blocked"));
        return;
      }
      let consumed = false;
      let settled = false;
      const finish = (result?: { subject: string; expiresAt: number }) => {
        if (settled) return;
        settled = true;
        browser.removeEventListener("message", onMessage);
        clearInterval(timer);
        popup.close();
        if (result) resolve(result);
        else reject(new Error("signin_failed"));
      };
      const onMessage = (event: MessageEvent<BoundaryValue>) => {
        if (consumed || event.origin !== brokerOrigin || event.source !== popup)
          return;
        if (
          Date.now() - createdAt > 300000 ||
          Date.now() < createdAt ||
          popup.closed
        ) {
          finish();
          return;
        }
        const data = event.data;
        if (
          !isJsonObject(data) ||
          data.type !== "opensesame:signin" ||
          data.state !== state
        )
          return;
        consumed = true;
        if (!isString(data.id_token) || data.error) {
          finish();
          return;
        }
        void validateLoopbackToken(data.id_token, profile, rpOrigin).then(
          (result) => finish(result),
          () => finish(),
        );
      };
      const timer = setInterval(() => {
        if (Date.now() - createdAt > 300000 || popup.closed) finish();
      }, 250);
      browser.addEventListener("message", onMessage);
    },
  );
}

function validateClaimTimes(
  claims: JsonObject,
  now: number,
): asserts claims is JsonObject & { exp: number; iat: number } {
  if (
    !isNumber(claims.exp) ||
    !Number.isSafeInteger(claims.exp) ||
    !isNumber(claims.iat) ||
    !Number.isSafeInteger(claims.iat) ||
    !claims.exp ||
    !claims.iat ||
    claims.exp <= now ||
    claims.iat > now + 30 ||
    claims.iat >= claims.exp ||
    (claims.nbf !== undefined &&
      (!isNumber(claims.nbf) ||
        !Number.isSafeInteger(claims.nbf) ||
        claims.nbf > now + 30))
  )
    throw new Error("invalid_token");
}
