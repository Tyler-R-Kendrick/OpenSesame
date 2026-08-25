import {
  hostLocalSessionEligible,
  useConnect,
  useIdentitySession,
} from "../../lib/identity.js";
import { shouldAutoConnect } from "../../lib/settings.js";
import { useStatusNotice } from "../../lib/use-status-notice.js";

/** Standing Identity-session trouble goes to the notifications tray, not the
 *  page (#259). Mount this wherever Host authorization is offered. */
export function IdentitySessionNote() {
  const session = useIdentitySession();
  const { connecting, error, connect } = useConnect();
  const relevant =
    !hostLocalSessionEligible() &&
    !session &&
    (shouldAutoConnect() || connecting || Boolean(error));
  useStatusNotice(
    relevant
      ? error
        ? {
            id: "identity-session",
            tone: "err",
            title: "OpenSesame Identity is unreachable",
            body: `Host connectors cannot authorize yet. Vault logins, passkeys, and import still work on this device. ${error}`,
            retry: connect,
            retryLabel: "Try Identity again",
          }
        : {
            id: "identity-session",
            tone: "info",
            title: "Starting your OpenSesame session",
            body: "Host connectors can authorize once the session is up. Vault items on this identity stay available either way.",
          }
      : null,
  );
  return null;
}
