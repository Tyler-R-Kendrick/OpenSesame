import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoundaryValue } from "@opensesame/os-domain";

/**
 * Wire helpers shared by every protocol this reference IdP speaks.
 *
 * The OIDC, OAuth2, RFC 7591 and SAML surfaces are separate modules but one
 * HTTP server; keeping the header/body plumbing here stops the three from
 * drifting apart on response hygiene.
 */

export interface SecurityHeaderOverrides {
  "content-type"?: string;
  location?: string;
  "access-control-allow-origin"?: string;
  "access-control-allow-methods"?: string;
  "access-control-allow-headers"?: string;
  vary?: string;
}

export interface HiddenFormField {
  name: string;
  value: string;
}

export function securityHeaders(
  extra: SecurityHeaderOverrides = {},
  issuer = "",
) {
  const headers = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-permitted-cross-domain-policies": "none",
    ...extra,
  };
  if (issuer.startsWith("https://")) {
    return {
      ...headers,
      "strict-transport-security": "max-age=63072000; includeSubDomains",
    };
  }
  return headers;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: BoundaryValue,
  issuer = "",
  extra: SecurityHeaderOverrides = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(
    status,
    securityHeaders({ "content-type": "application/json", ...extra }, issuer),
  );
  res.end(payload);
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  issuer = "",
): void {
  res.writeHead(
    status,
    securityHeaders({ "content-type": "text/html; charset=utf-8" }, issuer),
  );
  res.end(html);
}

export function sendXml(
  res: ServerResponse,
  status: number,
  xml: string,
  issuer = "",
): void {
  res.writeHead(
    status,
    securityHeaders({ "content-type": "application/samlmetadata+xml" }, issuer),
  );
  res.end(xml);
}

export function sendForm(
  res: ServerResponse,
  status: number,
  body: URLSearchParams,
  issuer = "",
): void {
  res.writeHead(
    status,
    securityHeaders(
      { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      issuer,
    ),
  );
  res.end(body.toString());
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function parseForm(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The self-posting HTML document a `response_mode=form_post` authorization
 * response (Apple) and every SAML HTTP-POST binding answer are delivered in.
 *
 * The auto-submit script is the real wire behavior: a browser POSTs the fields
 * cross-site the moment the document loads. The `<noscript>` button keeps the
 * page usable without scripting, which is also what the real IdPs ship.
 */
export function autoSubmitFormHtml(
  action: string,
  fields: HiddenFormField[],
  title: string,
): string {
  const inputs = fields
    .map(
      (f) =>
        `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value)}"/>`,
    )
    .join("");
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"/>',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body onload="document.forms[0].submit()">',
    `<form method="post" action="${escapeHtml(action)}">`,
    inputs,
    '<noscript><button type="submit">Continue</button></noscript>',
    "</form>",
    "<script>document.forms[0].submit();</script>",
    "</body></html>",
  ].join("");
}

export function basicClientId(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded.split(":")[0];
}

export function basicClientSecret(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  return idx >= 0 ? decoded.slice(idx + 1) : undefined;
}

/** The bearer token of an `Authorization: Bearer`/`token` header, if any. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
  if (header.startsWith("token ")) return header.slice("token ".length);
  return undefined;
}
