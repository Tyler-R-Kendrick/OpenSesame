import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  readString,
} from "@opensesame/os-domain";

/**
 * Device-authorization approval.
 *
 * This flow was written four separate times — twice in the Pages authority
 * section, once in the console, once in the ceremonies app — each with its own
 * status-code handling and its own wording for the same failures. ADR 0045
 * named the duplication and ADR 0140 D3 finished it: this is the single copy,
 * and Pages' directory client (`app-core/lib/directory.ts`) delegates here.
 *
 * Approving grants a short-lived client session. It does **not** transfer
 * ownership of agents, projects, or resources: that is the claim ceremony, and
 * ADR 0009 keeps the two apart on purpose.
 */

/** A ceremony call that failed in a way worth telling the human about. */
export class CeremonyRequestError extends Error {
  readonly status: number;
  /** The error code the server's body named, or `""` when it named none. */
  readonly code: string;
  constructor(status: number, message: string, code = "") {
    super(message);
    this.name = "CeremonyRequestError";
    this.status = status;
    this.code = code;
  }
}

/** The Identity API's answer: its proxy wraps the Host's status. */
export type DeviceApproval = {
  ok: boolean;
  status: number;
};

export interface ApproveDeviceInput {
  /**
   * Identity API origin, resolved at runtime from the deployment's settings.
   * Empty when `fetchImpl` resolves the origin itself (Pages' `identityFetch`
   * takes a path).
   */
  baseUrl: string;
  userCode: string;
  /**
   * The surface's own fetch. Pages passes one that already carries its bearer
   * and its local-network timeouts; a caller with nothing to add passes the
   * global.
   */
  fetchImpl: typeof fetch;
  /** Whether to send cookies. Cookie-authenticated surfaces need `include`. */
  credentials?: RequestCredentials;
  /**
   * Wording for a failure whose body names no code this module knows. The
   * default is keyed on the status; Pages passes its Identity transport's
   * wording so every directory call reads alike.
   */
  fallbackWords?: (status: number, detail: string | null) => string;
}

/**
 * The failures the Identity API names in its body, in plain words.
 *
 * The body's code outranks the status because the Identity API is a *proxy*
 * here (`packages/control-plane/src/routes/device.ts`): one status covers
 * unrelated causes — `host_api_unreachable` (the Host is down) and
 * `host_approval_failed` (the Host said no) both arrive as 502,
 * `invalid_request` and `organization_id_required` both as 400 — and a 403
 * carrying `organization_access_denied` is an organization refusal, never a
 * missing sign-in.
 */
export function deviceApprovalWords(
  code: string,
  status: number,
): string | null {
  switch (code) {
    case "operator_token_unconfigured":
      return "Device approval is not enabled on this sign-in service.";
    case "host_api_unreachable":
      return "Approval could not be delivered. Try again when the service is reachable.";
    case "host_approval_failed":
      return status === 404
        ? "No device is waiting on that code — check the code the device shows and try again."
        : "That code could not be approved — ask the device for a fresh one and try again.";
    case "invalid_request":
      return "Enter the user code exactly as the device shows it.";
    case "organization_id_required":
      return "You belong to several organizations — the operator approves devices for those.";
    case "organization_access_denied":
      return "You do not have access to the organization that device is joining.";
    default:
      return null;
  }
}

/** Status-keyed wording for a failure whose body names no known code. */
function statusWords(status: number): string {
  if (status === 401 || status === 403) {
    return "Sign in first, then approve this code. Use the same hostname as this page — mixing localhost and 127.0.0.1 drops the session cookie.";
  }
  if (status === 404) return "That user code was not found or has expired.";
  return `Approval failed (${status}). Try again shortly.`;
}

/** The body as a JSON object, or `null` for no body, non-JSON or a bare stub. */
async function readBody(res: Response): Promise<JsonObject | null> {
  try {
    const body: BoundaryValue = await res.json();
    return isJsonObject(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Approve a device/CLI user code, mapping the failures a human can act on.
 *
 * Only the user code leaves the client: the Identity API injects its operator
 * token and forwards `{user_code, principal, …}` to the Host. Throws
 * `CeremonyRequestError` carrying the status and the body's code, so callers
 * can tell "sign in first" from "that code expired" from "not your
 * organization" without re-deriving it. A transport failure propagates as
 * thrown by `fetchImpl`.
 */
export async function approveDevice({
  baseUrl,
  userCode,
  fetchImpl,
  credentials = "include",
  fallbackWords = (status) => statusWords(status),
}: ApproveDeviceInput): Promise<DeviceApproval> {
  const code = userCode.trim();
  if (!code) {
    throw new CeremonyRequestError(
      0,
      "Enter the user code shown on the device.",
    );
  }
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchImpl(`${base}/v1/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_code: code }),
    credentials,
  });
  const body = await readBody(res);
  if (res.ok) {
    // A body-less success (204) is a plain yes; a JSON one is the proxy's
    // `{ok, status}` read as sent.
    if (body === null) return { ok: true, status: res.status };
    return {
      ok: body.ok === true,
      status: isNumber(body.status) ? body.status : 200,
    };
  }
  const errorCode = readString(body?.error) ?? "";
  const detail = readString(body?.message) ?? readString(body?.hint) ?? null;
  throw new CeremonyRequestError(
    res.status,
    deviceApprovalWords(errorCode, res.status) ??
      fallbackWords(res.status, detail),
    errorCode,
  );
}
