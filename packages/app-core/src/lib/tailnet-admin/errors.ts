/**
 * Why a tailnet admin call did not happen, as a code a panel branches on and
 * the words it shows. The daemon's own codes (`tags_required`,
 * `tailscale_rejected`, …) pass through unchanged; the page adds its own for
 * what happens before a request leaves (`not-a-code`, `locked`, …).
 */

/** Codes the page raises itself; the daemon's arrive as they were sent. */
export type TailnetLocalCode =
  | "not-a-code"
  | "other-origin"
  | "locked"
  | "shared-origin"
  | "unreachable"
  | "pairing-refused"
  | "malformed"
  | "target-changed"
  | "no-daemon";

export class TailnetAdminError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    /** Tailscale's own explanation of a refused request, when it gave one. */
    readonly detail = "",
  ) {
    super(code);
    this.name = "TailnetAdminError";
  }
}

const SAID = {
  "not-a-code":
    "That is not a tailnet pairing code. Run `opensesame daemon tailnet pair` and paste what it prints.",
  "other-origin":
    "This code was printed for another web address. Pair again with --origin set to this page's address.",
  locked: "Unlock a vault you own to pair; a guest cannot hold the key.",
  "shared-origin":
    "This shared-origin demo cannot manage tailnet devices. Use a dedicated or loopback deployment.",
  unreachable:
    "The daemon did not answer. Check that it runs and that Tailscale Serve reaches it.",
  "pairing-refused":
    "The daemon refused the code: it was used, expired after five minutes, or is unknown. Pair again.",
  malformed: "The daemon answered with something this page cannot read.",
  "target-changed": "The pairing changed while this was in flight. Try again.",
  "no-daemon": "No daemon is paired for device management.",
  tailnet_pairing_required:
    "The daemon no longer knows this page's key. Pair again.",
  role_forbidden: "This pairing may read the tailnet but not change it.",
  tailnet_not_connected:
    "The daemon has no tailnet connected. Run `opensesame daemon tailnet connect` on it.",
  tailnet_admin_unavailable:
    "The daemon has nowhere to keep its tailnet state.",
  tailscale_credential_refused:
    "Tailscale refused the daemon's credential: it expired or lacks the scope this needs.",
  tailscale_unavailable: "Tailscale did not answer. Try again shortly.",
  tailscale_rejected: "Tailscale refused the change.",
  tags_required:
    "A key minted through an OAuth client must carry at least one tag.",
  not_found: "That device or key is no longer on the tailnet.",
  rate_limited: "Too many changes at once. Wait a moment and try again.",
  invalid_name: "A name is one label of lowercase letters, digits and hyphens.",
  invalid_tags:
    "Each tag is tag: and a lowercase name that starts with a letter.",
  invalid_routes:
    "Each route is an address range such as 10.0.0.0/16, with no host bits set.",
  invalid_description:
    "A description is at most 50 letters, digits, spaces and hyphens.",
  invalid_expiry: "A key lasts between one hour and 90 days.",
} as const;

function said(code: string): string | undefined {
  for (const [key, text] of Object.entries(SAID)) if (key === code) return text;
  return undefined;
}

/** What a panel shows for an error: its words, and Tailscale's when it gave some. */
export function tailnetErrorText(error: TailnetAdminError): string {
  const text =
    said(error.code) ?? `The daemon refused the request (${error.code}).`;
  return error.detail ? `${text} ${error.detail}` : text;
}
