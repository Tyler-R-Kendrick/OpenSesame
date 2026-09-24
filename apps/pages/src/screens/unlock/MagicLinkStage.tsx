import { requestEmailMagicLink } from "@opensesame/app-core/lib/providers.js";
import { type ReactElement, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconMail } from "../../components/Icons.js";

/**
 * Sign in by a link to an address: the address, one key that sends it, and
 * what happened. The address is the identifier — the link proves it, and
 * the proven address becomes an identity on the principal (D18).
 */
export function MagicLinkStage({
  busy,
  setBusy,
  back,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  back: ReactElement;
}) {
  const [linkEmail, setLinkEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function sendMagicLink(): Promise<void> {
    setLinkError(null);
    setBusy(true);
    try {
      await requestEmailMagicLink(linkEmail.trim());
      setLinkSent(true);
    } catch (caught) {
      setLinkError(
        caught instanceof Error
          ? caught.message
          : "Could not send the sign-in link.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      {back}
      <div className="field">
        <label htmlFor="signin-link-email">Email me a sign-in link</label>
        <div className="identifier__row">
          <input
            id="signin-link-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={linkEmail}
            placeholder="you@example.com"
            disabled={busy || linkSent}
            onChange={(e) => {
              setLinkEmail(e.target.value);
              setLinkError(null);
            }}
          />
          <IconKey
            label={linkSent ? "Sent" : "Send link"}
            disabled={busy || linkSent || linkEmail.trim().length === 0}
            onClick={() => void sendMagicLink()}
          >
            <IconMail size={16} />
          </IconKey>
        </div>
        {linkSent ? (
          <p className="hint">Check your email for a sign-in link.</p>
        ) : null}
        {linkError ? (
          <p className="hint identifier__error" role="alert">
            {linkError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
