import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import {
  assertSafeMetadataUrl,
  resolveSafeMetadataAddresses,
} from "@opensesame/oauth-provider/metadata/safe-fetcher";

export type SupportProxyConfig = {
  readonly url: string;
  readonly token: string;
};
export function readSupportProxyConfig(
  env: NodeJS.ProcessEnv,
): SupportProxyConfig | undefined {
  const url = env.OPENSESAME_SUPPORT_UPSTREAM_URL;
  const token = env.OPENSESAME_SUPPORT_UPSTREAM_TOKEN;
  if (url === undefined && token === undefined) return undefined;
  if (!url || !token || token.length < 32 || /[\r\n]/.test(token))
    throw new Error(
      "Support proxy requires an endpoint and strong server credential",
    );
  let parsed: URL;
  try {
    parsed = assertSafeMetadataUrl(url);
  } catch {
    throw new Error("Support proxy requires a public HTTPS endpoint");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Support proxy requires a plain HTTPS endpoint");
  return { url: parsed.href, token };
}

/** Existing public-address policy, pinned connection, no redirects, bounded response. */
export async function postSupportProxy(
  config: SupportProxyConfig,
  body: string,
  signal: AbortSignal,
): Promise<string> {
  readSupportProxyConfig({
    OPENSESAME_SUPPORT_UPSTREAM_URL: config.url,
    OPENSESAME_SUPPORT_UPSTREAM_TOKEN: config.token,
  });
  const url = assertSafeMetadataUrl(config.url);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  deadline.throwIfAborted();
  let refuseDns: (() => void) | undefined;
  const addresses = await Promise.race([
    resolveSafeMetadataAddresses(url, lookup),
    new Promise<never>((_resolve, reject) => {
      refuseDns = () => reject(new Error("Support timeout"));
      deadline.addEventListener("abort", refuseDns, { once: true });
    }),
  ]).finally(() => {
    if (refuseDns) deadline.removeEventListener("abort", refuseDns);
  });
  deadline.throwIfAborted();
  const address = addresses[0];
  if (!address) throw new Error("Support endpoint unavailable");
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const request = https.request(
      {
        hostname: address,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        servername: isIP(hostname) ? undefined : hostname,
        agent: false,
        rejectUnauthorized: true,
        signal: deadline,
        headers: {
          host: url.host,
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          !response.headers["content-type"]?.startsWith("text/event-stream")
        ) {
          response.destroy();
          reject(new Error("Support response refused"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 262_144) {
            response.destroy();
            reject(new Error("Support response too large"));
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

export const supportProxySeams = { post: postSupportProxy };
