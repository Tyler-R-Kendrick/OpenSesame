/**
 * Posting to an endpoint somebody else chose.
 *
 * A Web Push endpoint is whatever URL a browser handed us, and a Teams
 * incoming-webhook URL can come from a per-binding row. Neither is ours, so
 * neither may point the delivery worker at loopback, a private network or a
 * cloud metadata service, and neither may bounce it there with a redirect.
 *
 * The policy is the repository's one public-only policy, not a second one:
 * `assertSafeMetadataUrl` judges the URL as written, and
 * `resolveSafeMetadataAddresses` refuses when ANY resolved address is private
 * or special — the same functions `@opensesame/webhooks/delivery` uses. The
 * connection is then pinned to the verified address with the original name as
 * Host and SNI, so a second DNS answer at connect time is not what we talk to.
 *
 * `postWebhook` already does all of this for a string body. `postPublicOnly`
 * is the same transport for the binary `aes128gcm` body RFC 8291 requires.
 */

import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import {
  type MetadataDnsLookup,
  assertSafeMetadataUrl,
  resolveSafeMetadataAddresses,
} from "@opensesame/oauth-provider/metadata/safe-fetcher";

import type { DeliveryOutcome } from "./contract.js";
import {
  classifyThrown,
  deliveryAbortSignal,
  httpOutcome,
  isHttpsUrl,
} from "./http.js";

export type EndpointRefusal = "insecure_endpoint" | "private_endpoint";

/**
 * The synchronous half of the policy, run before any request is built: HTTPS
 * only, no userinfo, and no literal loopback, private, link-local or metadata
 * host. Names that merely *resolve* somewhere private are caught by the
 * transport, which is the only place that sees the answer it connects to.
 */
export function endpointRefusal(
  rawUrl: string | undefined,
): EndpointRefusal | undefined {
  if (!rawUrl || !isHttpsUrl(rawUrl)) return "insecure_endpoint";
  const url = new URL(rawUrl);
  if (url.username || url.password) return "insecure_endpoint";
  try {
    assertSafeMetadataUrl(rawUrl);
  } catch {
    return "private_endpoint";
  }
  return undefined;
}

export interface PublicPostInit<B extends string | Buffer> {
  method: "POST";
  redirect: "error";
  headers: Record<string, string>;
  body: B;
  signal: AbortSignal;
}

export type PublicPost<B extends string | Buffer> = (
  url: string,
  init: PublicPostInit<B>,
) => Promise<Response>;

/**
 * POST `init.body` to `url` after the refusal check, and turn whatever
 * happens into a delivery outcome. A refused endpoint is permanent: it will
 * not become public by being retried, and no request is made for it.
 */
export async function deliverToPublicEndpoint<B extends string | Buffer>(
  post: PublicPost<B>,
  url: string,
  headers: Record<string, string>,
  body: B,
): Promise<DeliveryOutcome> {
  const refusal = endpointRefusal(url);
  if (refusal) return { status: "permanent", error: refusal };
  try {
    const response = await post(url, {
      method: "POST",
      redirect: "error",
      headers,
      body,
      signal: deliveryAbortSignal(),
    });
    return httpOutcome(response.status);
  } catch (err) {
    return classifyThrown(err instanceof Error ? err : undefined);
  }
}

/**
 * Public-only, DNS-pinned HTTPS POST. Redirects are never followed — the
 * status is reported and the reply is discarded unread, so a hostile endpoint
 * can neither steer the request nor make us buffer its answer.
 */
export async function postPublicOnly(
  rawUrl: string,
  init: PublicPostInit<string | Buffer>,
  lookupFn: MetadataDnsLookup = lookup,
): Promise<Response> {
  const url = assertSafeMetadataUrl(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Endpoint must be HTTPS without userinfo");
  }
  const signal = init.signal;
  signal.throwIfAborted();
  // A hung resolver must not outlive the delivery deadline.
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  const addresses = resolveSafeMetadataAddresses(url, lookupFn);
  // Whichever loses the race still settles; neither may surface unhandled.
  for (const pending of [aborted, addresses]) pending.catch(() => undefined);
  const [address] = await Promise.race([addresses, aborted]);
  if (!address) throw new Error("Endpoint has no public address");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(
      {
        hostname: address,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...init.headers, host: url.host },
        servername: isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true,
        agent: false,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 502;
        response.destroy();
        resolve(
          new Response(null, {
            status: status >= 200 && status <= 599 ? status : 502,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(init.body);
  });
}
