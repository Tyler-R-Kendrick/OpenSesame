import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http.js";

function isOriginClientId(clientId: string): boolean {
  return clientId.startsWith("origin:");
}

export function originFromClientId(clientId: string): string | undefined {
  if (!isOriginClientId(clientId)) return undefined;
  const origin = clientId.slice("origin:".length);
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return undefined;
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return origin;
  } catch {
    return undefined;
  }
}

export function refuseInvalidAuthorizeRequest(input: {
  res: ServerResponse;
  issuer: string;
  responseType: string;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
}): boolean {
  if (input.responseType !== "code") {
    sendJson(
      input.res,
      400,
      { error: "unsupported_response_type" },
      input.issuer,
    );
    return true;
  }
  if (!input.codeChallenge || (input.codeChallengeMethod ?? "") !== "S256") {
    sendJson(
      input.res,
      400,
      {
        error: "invalid_request",
        error_description: "PKCE S256 required",
      },
      input.issuer,
    );
    return true;
  }
  return false;
}

/** prompt=none with no IdP session cookie → correlated login_required. */
export function refusePromptNoneWithoutSession(input: {
  req: IncomingMessage;
  res: ServerResponse;
  prompt: string;
  redirectUri: string;
  state: string | null;
  headers: (extra: Record<string, string>) => Record<string, string>;
}): boolean {
  if (!input.prompt.includes("none")) return false;
  const cookies = input.req.headers.cookie ?? "";
  if (cookies.includes("mock_idp_session=1")) return false;
  const target = new URL(input.redirectUri);
  target.searchParams.set("error", "login_required");
  if (input.state) target.searchParams.set("state", input.state);
  input.res.writeHead(302, input.headers({ location: target.toString() }));
  input.res.end();
  return true;
}
