/** DNS is resolved and checked once; the connection uses the checked IPv4 address. */
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");

type Resolve = (
  host: string,
) => Promise<readonly { address: string; family: number }[]>;
const systemResolve: Resolve = (host) => lookup(host, { all: true, family: 4 });

export async function resolvePinnedAddress(
  host: string,
  allowLoopback: boolean,
  resolve: Resolve = systemResolve,
): Promise<string> {
  if (allowLoopback && (host === "localhost" || host === "127.0.0.1"))
    return "127.0.0.1";
  if (isIP(host) === 6 || host.startsWith("["))
    throw new Error("virtual network: IPv6 destinations are not supported");
  const records =
    isIP(host) === 4 ? [{ address: host, family: 4 }] : await resolve(host);
  if (
    records.length === 0 ||
    records.some(
      (record) =>
        record.family !== 4 ||
        isIP(record.address) !== 4 ||
        blocked.check(record.address, "ipv4"),
    )
  )
    throw new Error(
      "virtual network: destination does not resolve exclusively to public IPv4 addresses",
    );
  const first = records[0];
  if (!first) throw new Error("virtual network: destination has no addresses");
  return first.address;
}

export function pinnedFetch(allowLoopback: boolean): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const address = await resolvePinnedAddress(url.hostname, allowLoopback);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    headers["accept-encoding"] = "identity";
    return await new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          method: init?.method ?? "GET",
          headers,
          family: 4,
          lookup: (_host, _options, callback) => callback(null, address, 4),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let length = 0;
          res.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 2_000_000) {
              req.destroy(new Error("virtual network: response too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (
                res.headers["content-encoding"] &&
                res.headers["content-encoding"] !== "identity"
              )
                throw new Error(
                  "virtual network: encoded response is not supported",
                );
              const responseHeaders = new Headers();
              for (const [key, value] of Object.entries(res.headers)) {
                for (const entry of Array.isArray(value)
                  ? value
                  : value === undefined
                    ? []
                    : [value])
                  responseHeaders.append(key, entry);
              }
              const status = res.statusCode ?? 502;
              const body = [204, 205, 304].includes(status)
                ? null
                : Buffer.concat(chunks).toString("utf8");
              resolve(new Response(body, { status, headers: responseHeaders }));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(15_000, () =>
        req.destroy(new Error("virtual network: request timed out")),
      );
      if (typeof init?.body === "string") req.write(init.body);
      req.end();
    });
  };
}
