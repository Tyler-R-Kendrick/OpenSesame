export const CLI_AUTHORIZE_LOAD_BLOCKED =
  "CLI pairing is optional and only works on your own deployment, where a passkey approves the terminal. Local CLI approval is blocked on this site.";
export const CLI_AUTHORIZE_LOAD_UNREADABLE = "Couldn't check for CLI requests.";
/** The passkey commit on a deployment that can reach a local CLI. */
export const CLI_AUTHORIZE_PASSKEY_NAME = "Authorize with passkey";
export const CLI_AUTHORIZE_PASSKEY_MISSING =
  "No passkey is stored for CLI approval. Pair again in this browser before a request can be approved.";
export const CLI_AUTHORIZE_PASSKEY_UNSUPPORTED =
  "This browser cannot use a passkey, so CLI approval cannot succeed.";

export const CLI_AUTHORIZE_RESPOND_UNREACHABLE =
  "The approval service could not be reached.";

export function cliAuthorizeRespondMessage(status: string): string {
  switch (status) {
    case "wrongSession":
      return "The passkey proof was rejected.";
    case "expired":
      return "That request expired.";
    case "cli_app_pairing_required":
      return "Pairing is missing. Pair again before approving.";
    case "origin_required":
      return "This page's origin was not accepted.";
    default:
      return `That approval did not succeed (${status}).`;
  }
}
