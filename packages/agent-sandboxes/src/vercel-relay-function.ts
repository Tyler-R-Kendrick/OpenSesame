/**
 * Source of the virtual-network relay as a Vercel serverless function.
 *
 * Deployed to an anonymous temporary Vercel project, this gives the
 * WASM lane a real network egress with no vendor account and no
 * claim: the project is anonymous, the deployment is per-run, and it
 * expires on its own. It implements the same `/fetch` and `/close`
 * contract as `vnet.ts`: bearer-authenticated, origin allowlist
 * enforced on every hop including redirects, body capped. The cookie
 * jar is per-session in function memory (anonymous projects have no
 * KV); sessions are single-run and short-lived.
 */
export const VERCEL_RELAY_FETCH_SOURCE = `
const MAX_BODY = 1048576;
const jars = new Map();
function jarFor(sessionId) {
  if (!jars.has(sessionId)) jars.set(sessionId, {});
  return jars.get(sessionId);
}
function cookieHeader(jar, origin) {
  return Object.entries(jar[origin] ?? {}).map(([k, v]) => k + "=" + v).join("; ");
}
function storeCookies(jar, origin, headers) {
  const set = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const line of set) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    if (!jar[origin]) jar[origin] = {};
    jar[origin][pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
module.exports = async function handler(req, res) {
  if (!process.env.RELAY_TOKEN || req.headers.authorization !== "Bearer " + process.env.RELAY_TOKEN)
    return res.status(401).send("unauthorized");
  if (req.method !== "POST") return res.status(405).send("method");
  let rpc;
  try { rpc = JSON.parse(await readBody(req)); } catch { return res.status(400).send("bad json"); }
  const origins = Array.isArray(rpc.allowedOrigins) ? rpc.allowedOrigins : [];
  if (!rpc.sessionId || !rpc.url || !origins.length)
    return res.status(400).send("bad request");
  if (!["GET", "HEAD", "POST"].includes(rpc.method))
    return res.status(405).send("method refused");
  let url;
  try { url = new URL(rpc.url); } catch { return res.status(400).send("bad url"); }
  if (!origins.includes(url.origin)) return res.status(403).send("origin refused");
  const jar = jarFor(String(rpc.sessionId));
  let current = url;
  let method = rpc.method;
  let body = typeof rpc.body === "string" ? rpc.body : undefined;
  for (let hop = 0; hop < 8; hop++) {
    const headers = new Headers(rpc.headers ?? {});
    headers.delete("host");
    headers.delete("cookie");
    const cookies = cookieHeader(jar, current.origin);
    if (cookies) headers.set("cookie", cookies);
    const response = await fetch(current.href, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      redirect: "manual",
    });
    storeCookies(jar, current.origin, response.headers);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return finish(response, current);
      const next = new URL(location, current);
      if (!origins.includes(next.origin))
        return res.status(403).send("redirect refused");
      if (response.status === 303) { method = "GET"; body = undefined; }
      current = next;
      continue;
    }
    return finish(response, current);
  }
  return res.status(502).send("too many redirects");
  async function finish(response, finalUrl) {
    const text = (await response.text()).slice(0, MAX_BODY);
    const headers = {};
    response.headers.forEach((v, k) => { if (k.toLowerCase() !== "set-cookie") headers[k] = v; });
    return res.status(200).json({ status: response.status, url: finalUrl.href, headers, bodyText: text });
  }
}
`;

export const VERCEL_RELAY_CLOSE_SOURCE = `
module.exports = function handler(req, res) {
  if (!process.env.RELAY_TOKEN || req.headers.authorization !== "Bearer " + process.env.RELAY_TOKEN)
    return res.status(401).send("unauthorized");
  return res.status(200).json({ ok: true });
}
`;
