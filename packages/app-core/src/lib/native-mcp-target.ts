/** Provider-owned MCP destinations; form values never become request URLs. */
export type NativeMcpBinding = {
  providerId: string;
  fingerprint: string;
  endpoint: string;
  resource: string;
  issuer: string | null;
  transport: "streamable-http" | "sse";
  /** Legacy SSE announces a message URL. Its path must also be provider-pinned. */
  ssePostEndpoint?: string;
};

export type NativeMcpErrorCode =
  | "target"
  | "authorization"
  | "permission"
  | "browser-transport"
  | "response"
  | "tool"
  | "arguments"
  | "schema-limits"
  | "disposed";

export class NativeMcpError extends Error {
  readonly name = "NativeMcpError";
  constructor(
    readonly code: NativeMcpErrorCode,
    readonly status = 0,
    argumentFormat?: "json-object",
  ) {
    const messages = {
      target: "The MCP destination does not match this connector.",
      authorization: "Authorize this connector again before using its tools.",
      permission: "The MCP server refused this operation.",
      "browser-transport":
        "The browser could not reach this MCP server. Check the connection and whether the server permits this app origin.",
      response: "The MCP server returned an invalid or oversized response.",
      tool: "Select a tool advertised by this MCP server.",
      arguments:
        "Enter arguments that match this tool’s advertised input schema.",
      "schema-limits":
        "This tool’s schema exceeds browser safety limits. Ask the MCP provider for a simpler schema or smaller arguments.",
      disposed: "This connector session has ended. Connect again.",
    };
    super(
      code === "arguments" && argumentFormat === "json-object"
        ? "Enter valid JSON object arguments for this tool."
        : messages[code],
    );
  }
}

export function nativeMcpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NativeMcpError("target");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new NativeMcpError("target");
  return url;
}

export function validateNativeMcpBinding(binding: NativeMcpBinding): void {
  const endpoint = nativeMcpUrl(binding.endpoint);
  const resource = nativeMcpUrl(binding.resource);
  if (!binding.providerId || !binding.fingerprint)
    throw new NativeMcpError("target");
  const resourcePath = resource.pathname.replace(/\/$/, "");
  if (
    endpoint.origin !== resource.origin ||
    (endpoint.pathname !== resourcePath &&
      !endpoint.pathname.startsWith(`${resourcePath}/`))
  )
    throw new NativeMcpError("target");
  if (binding.issuer) nativeMcpUrl(binding.issuer);
  if (binding.ssePostEndpoint) {
    const post = nativeMcpUrl(binding.ssePostEndpoint);
    if (binding.transport !== "sse" || post.origin !== endpoint.origin)
      throw new NativeMcpError("target");
  }
}

export function admitNativeMcpRequest(
  binding: NativeMcpBinding,
  destination: URL,
  method: string,
): void {
  if (
    destination.href === binding.endpoint &&
    ["GET", "POST", "DELETE"].includes(method)
  )
    return;
  if (
    binding.transport === "sse" &&
    binding.ssePostEndpoint &&
    method === "POST"
  ) {
    const pinned = nativeMcpUrl(binding.ssePostEndpoint);
    const query = [...destination.searchParams.keys()];
    if (
      destination.origin === pinned.origin &&
      destination.pathname === pinned.pathname &&
      query.every((key) => key === "sessionId") &&
      query.length <= 1
    )
      return;
  }
  throw new NativeMcpError("target");
}
