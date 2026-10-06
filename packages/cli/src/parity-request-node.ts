import type { LookupAddress } from "node:dns";
/** HTTPS effects: validated DNS is pinned while TLS verifies the original hostname. */
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import type {
  Address,
  PreparedRequest,
  RawResponse,
  RequestLimits,
} from "@opensesame/app-core/lib/password-agent/request.js";

export async function requestAddresses(
  hostname: string,
): Promise<readonly Address[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  return (await boundedLookup(hostname)).map((value) => {
    if (value.family !== 4 && value.family !== 6)
      throw new Error("Invalid DNS address family");
    return { address: value.address, family: value.family };
  });
}

export function sendPrivateRequest(
  prepared: PreparedRequest,
  secret: string,
  address: Address,
  limits: RequestLimits,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const outgoing = request(
      prepared.url,
      {
        method: "GET",
        agent: false,
        family: address.family,
        headers: { [prepared.header]: `${prepared.prefix}${secret}` },
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (response) => {
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > limits.maxBytes) {
            reject(new Error("Response limit exceeded"));
            outgoing.destroy(new Error("Response limit exceeded"));
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new Error("Private response failed")),
        );
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
            bytes,
          }),
        );
      },
    );
    const deadline = setTimeout(() => {
      reject(new Error("Request deadline exceeded"));
      outgoing.destroy(new Error("Request deadline exceeded"));
    }, limits.timeoutMs);
    outgoing.on("close", () => clearTimeout(deadline));
    outgoing.on("error", () => reject(new Error("Private request failed")));
    outgoing.end();
  });
}

function boundedLookup(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("DNS deadline exceeded")),
      15000,
    );
    lookup(hostname, { all: true, verbatim: true })
      .then(resolve, reject)
      .finally(() => clearTimeout(deadline));
  });
}
