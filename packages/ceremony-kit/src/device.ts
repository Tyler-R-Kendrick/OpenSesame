/**
 * Device-authorization approval.
 *
 * This flow was written four separate times — twice in the Pages authority
 * section, once in the console, once in the ceremonies app — each with its own
 * status-code handling and its own wording for the same failures. ADR 0045
 * named the duplication; this is the single copy.
 *
 * Approving grants a short-lived client session. It does **not** transfer
 * ownership of agents, projects, or resources: that is the claim ceremony, and
 * ADR 0009 keeps the two apart on purpose.
 */

/** A ceremony call that failed in a way worth telling the human about. */
export class CeremonyRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CeremonyRequestError";
    this.status = status;
  }
}

export interface ApproveDeviceInput {
  /** Identity API origin. Build-time for the ceremonies app, runtime for Pages. */
  baseUrl: string;
  userCode: string;
  /**
   * The surface's own fetch. Pages passes one that already carries its bearer
   * and its local-network timeouts; the ceremonies app passes the global.
   */
  fetchImpl: typeof fetch;
  /** Whether to send cookies. Cookie-authenticated surfaces need `include`. */
  credentials?: RequestCredentials;
}

/**
 * Approve a device/CLI user code, mapping the failures a human can act on.
 *
 * Throws `CeremonyRequestError` so callers can distinguish "sign in first"
 * from "that code expired" without re-deriving it from a status code.
 */
export async function approveDevice({
  baseUrl,
  userCode,
  fetchImpl,
  credentials = "include",
}: ApproveDeviceInput): Promise<void> {
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
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new CeremonyRequestError(
      res.status,
      "Sign in first, then approve this code. Use the same hostname as this page — mixing localhost and 127.0.0.1 drops the session cookie.",
    );
  }
  if (res.status === 404) {
    throw new CeremonyRequestError(
      res.status,
      "That user code was not found or has expired.",
    );
  }
  throw new CeremonyRequestError(
    res.status,
    `Approval failed (${res.status}). Try again shortly.`,
  );
}
