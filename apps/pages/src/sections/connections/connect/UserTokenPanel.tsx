import { openConsentPopup } from "@opensesame/app-core/lib/connections.js";
import {
  type TokenCheck,
  authorizeConnectorAs,
  checkConnectorToken,
} from "@opensesame/app-core/lib/vercel-connect-manage.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { useState } from "react";
import { IconCheck, IconLogin } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { Facts } from "./fields.js";

const WAIT_MS = 10 * 60_000;

/** Resolves when the popup reports back, closes, or gives up. */
function settled(popup: Window | null): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
      resolve();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data: BoundaryValue = event.data;
      if (isJsonObject(data) && data.type === "opensesame:connection") done();
    };
    const timer = setInterval(() => {
      if (!popup || popup.closed || Date.now() - started > WAIT_MS) done();
    }, 500);
    window.addEventListener("message", onMessage);
  });
}

function CheckFacts({ check }: { check: TokenCheck }) {
  const verified = check.verified;
  return (
    <Facts
      rows={[
        ["Subject", check.subject === "user" ? "You" : "App"],
        ["Token", `sha256:${check.fingerprint}…`],
        [
          "Expires",
          check.expiresAt
            ? new Date(check.expiresAt).toLocaleString()
            : "Not stated",
        ],
        ["Scopes", check.scopes.join(" ") || "As granted"],
        [
          "Service",
          verified ? (
            <span className="cx-inline" key="verified">
              <StatusMark
                tone={verified.ok ? "ok" : "err"}
                label={
                  verified.ok
                    ? "Token accepted"
                    : `Refused (${verified.status})`
                }
              />
              <span>{verified.account || String(verified.status)}</span>
            </span>
          ) : (
            "No read-only check for this service"
          ),
        ],
      ]}
    />
  );
}

function TokenKeys({
  busy,
  authorizeOff,
  proveOff,
  onAuthorize,
  onProve,
}: {
  busy: "authorize" | "check" | null;
  authorizeOff: boolean;
  proveOff: boolean;
  onAuthorize: () => void;
  onProve: () => void;
}) {
  return (
    <div className="actions">
      <button
        type="button"
        className="icon-btn"
        aria-label="Authorize as you"
        title="Authorize as you"
        aria-busy={busy === "authorize" || undefined}
        disabled={authorizeOff}
        onClick={onAuthorize}
      >
        <IconLogin size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Test user token"
        title="Test user token"
        aria-busy={busy === "check" || undefined}
        disabled={proveOff}
        onClick={onProve}
      >
        <IconCheck size={16} />
      </button>
    </div>
  );
}

/**
 * The person's own token: authorize as yourself, then prove Connect can hand
 * a token over — acquired on the relay, fingerprinted, checked against the
 * service, and never sent to this page.
 */
export function UserTokenPanel({
  connectorId,
  subjectId,
  scopes,
  canManage,
  canProve,
  online,
  onFlash,
}: {
  connectorId: string;
  subjectId: string | null;
  scopes: string[];
  canManage: boolean;
  canProve: boolean;
  online: boolean;
  onFlash: (flash: Flash) => void;
}) {
  const [busy, setBusy] = useState<"authorize" | "check" | null>(null);
  const [check, setCheck] = useState<TokenCheck | null>(null);
  const subject = subjectId ? { type: "user" as const, id: subjectId } : null;

  async function prove() {
    if (!subject) return;
    setBusy("check");
    try {
      setCheck(await checkConnectorToken(connectorId, subject, scopes));
    } catch (error) {
      setCheck(null);
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  async function authorize() {
    if (!subject) return;
    const popup = openConsentPopup("about:blank");
    setBusy("authorize");
    try {
      const { authorizationUrl } = await authorizeConnectorAs(
        connectorId,
        subject,
        scopes,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;
      await settled(popup);
    } catch (error) {
      popup?.close();
      onFlash({ tone: "err", text: errorText(error) });
      setBusy(null);
      return;
    }
    setBusy(null);
    if (canProve) await prove();
  }

  const off = !online || !subject || busy !== null;
  return (
    <section className="panel" id="user-token" aria-label="User token">
      <div className="panel__head">
        <h2>User token</h2>
        <TokenKeys
          busy={busy}
          authorizeOff={off || !canManage}
          proveOff={off || !canProve}
          onAuthorize={() => void authorize()}
          onProve={() => void prove()}
        />
      </div>
      <div className="panel__body">
        {check ? (
          <CheckFacts check={check} />
        ) : (
          <Facts
            rows={[
              ["Subject", subjectId ?? "Unlock to authorize as you"],
              ["Scopes", scopes.join(" ") || "As configured"],
            ]}
          />
        )}
      </div>
    </section>
  );
}
