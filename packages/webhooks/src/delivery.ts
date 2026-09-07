import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import {
  type MetadataDnsLookup,
  assertSafeMetadataUrl,
  resolveSafeMetadataAddresses,
} from "@opensesame/oauth-provider/metadata/safe-fetcher";

interface WebhookPost {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: "error";
}

/** Public-only, DNS-pinned transport; the signing-only entry point stays pure. */
export async function postWebhook(
  rawUrl: string,
  init: WebhookPost,
  lookupFn: MetadataDnsLookup = lookup,
): Promise<Response> {
  const url = assertSafeMetadataUrl(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Webhook destination must be HTTPS without userinfo");
  }
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const send = async () => {
    const [address] = await resolveSafeMetadataAddresses(url, lookupFn);
    signal.throwIfAborted();
    if (!address) throw new Error("Webhook destination has no public address");
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
          // No redirects, body buffering, or unbounded draining of hostile replies.
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
  };
  try {
    return await Promise.race([send(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
