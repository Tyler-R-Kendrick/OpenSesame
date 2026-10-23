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

/** Resolves true only when this popup reports the connection it was opened for. */
function settled(popup: Window | null, connectionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!popup) {
      resolve(false);
      return;
    }
    const started = Date.now();
    let done = false;
    let timer = 0;
    const finish = (approved: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      if (timer !== 0) window.clearInterval(timer);
      resolve(approved);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup) return;
      if (event.origin !== window.location.origin) return;
      const data: BoundaryValue = event.data;
      if (
        isJsonObject(data) &&
        data.type === "opensesame:connection" &&
        data.connectionId === connectionId
      )
        finish(true);
    };
    const poll = () => {
      if (popup.closed || Date.now() - started > WAIT_MS) finish(false);
    };
    window.addEventListener("message", onMessage);
    poll();
    if (!done) timer = window.setInterval(poll, 500);
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

/**
 * Each key is drawn only where it can act (ADR 0158): Authorize when the
 * person may manage the connector and has an identity to authorize as, Prove
 * when this page holds a relay to prove through. `wait` is the one transient
 * reason to be disabled — a request in flight, or no network.
 */
function TokenKeys({
  busy,
  wait,
  authorize,
  prove,
  onAuthorize,
  onProve,
}: {
  busy: "authorize" | "check" | null;
  wait: boolean;
  authorize: boolean;
  prove: boolean;
  onAuthorize: () => void;
  onProve: () => void;
}) {
  return (
    <div className="actions">
      {authorize ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Authorize as you"
          title="Authorize as you"
          aria-busy={busy === "authorize" || undefined}
          disabled={wait}
          onClick={onAuthorize}
        >
          <IconLogin size={16} />
        </button>
      ) : null}
      {prove ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Test user token"
          title="Test user token"
          aria-busy={busy === "check" || undefined}
          disabled={wait}
          onClick={onProve}
        >
          <IconCheck size={16} />
        </button>
      ) : null}
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
      // `openConsentPopup` opens with `noopener`, so a browser does not hand
      // back a handle. Never wait on a window we cannot observe: a same-tab
      // navigation is the flow, and the callback page owns what follows.
      if (!popup) {
        window.location.assign(authorizationUrl);
        return;
      }
      popup.location.href = authorizationUrl;
      const approved = await settled(popup, connectorId);
      if (!approved) return;
      if (canProve) await prove();
    } catch (error) {
      popup?.close();
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  const wait = !online || busy !== null;
  return (
    <section className="panel" id="user-token" aria-label="User token">
      <div className="panel__head">
        <h2>User token</h2>
        <TokenKeys
          busy={busy}
          wait={wait}
          authorize={subject !== null && canManage}
          prove={subject !== null && canProve}
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
