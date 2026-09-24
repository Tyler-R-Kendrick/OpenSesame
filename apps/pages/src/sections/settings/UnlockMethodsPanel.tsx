export {
  onCompleteUnlockCodeSubmission,
  persistEnrollmentStateForUnlock,
} from "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js";
import { describeRecovery } from "@opensesame/app-core/lib/configuration/recovery-outcomes.js";
import { loadSession } from "@opensesame/app-core/lib/federation.js";
import { isRemoteIdentityConfigured } from "@opensesame/app-core/lib/identity.js";
import { RemoteCodeError } from "@opensesame/app-core/lib/vault/remote-code.js";
import {
  type CodeChannel,
  type UnlockMethodId,
  type WebauthnHostCheck,
  checkWebauthnHost,
  describeWebauthnError,
  listAvailableUnlockMethods,
  listSecondSteps,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { IconKey } from "../../components/IconKey.js";
import {
  IconEdit,
  IconEye,
  IconPlus,
  IconSettings,
  IconTrash,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { StatusNote } from "../../components/StatusNote.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { KEY_TITLE, type KeyKind } from "./security/KeyCeremony.js";
import {
  type MethodKind,
  MethodSheet,
  type SheetRequest,
  methodIcon,
} from "./security/MethodSheet.js";
import type { Run } from "./security/run.js";

const ENROLL_PASSKEY_PARAM = "enroll-passkey";

/**
 * Settings › Security. Three lists — the keys that open this vault, the
 * second steps asked after one, and the recovery codes — each a row of
 * read-only state with exactly one action. No row holds an input: every
 * form lives in the one sheet a row's action opens, so the PIN form exists
 * once, and the authenticator ceremony on a keyless vault reuses it as its
 * step 1 rather than drawing a second one (docs/design/auth-flow, ADR 0091).
 */
export function UnlockMethodsPanel() {
  return (
    <>
      <UnlockMethodsBody />
    </>
  );
}

function UnlockMethodsBody() {
  const { header, guest } = useVault();
  const store = useVaultStore();
  const enrolled = listAvailableUnlockMethods(header);
  const secondSteps = listSecondSteps(header);
  const hasRecovery = Boolean(header?.unlocks?.recovery);
  const hasIdentity = isRemoteIdentityConfigured();
  const accountEmail = loadSession()?.email ?? null;

  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  const [webauthnHost, setWebauthnHost] = useState<WebauthnHostCheck>(() =>
    checkWebauthnHost(),
  );
  const secondStepRef = useGuideTarget<HTMLElement>("settings.second-step");
  const recoveryRef = useGuideTarget<HTMLElement>("settings.recovery");
  // The one place a master password is set or changed (AGENTS.md: never a
  // second password form).
  const passwordRef = useGuideTarget<HTMLButtonElement>(
    "settings.master-password",
  );

  useEffect(() => {
    setWebauthnHost(checkWebauthnHost());
  }, []);

  const run = useCallback<Run>(async (action, ok) => {
    setMessage(null);
    setBusy(true);
    try {
      await action();
      setMessage({ tone: "ok", text: ok });
    } catch (caught) {
      setMessage({
        tone: "err",
        text:
          caught instanceof RemoteCodeError
            ? caught.message
            : describeWebauthnError(
                caught instanceof Error ? caught : "Unknown WebAuthn error",
              ),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  // Back from the localhost hop the passkey card offered: finish enrolling.
  const hasPasskey = enrolled.includes("passkey");
  useEffect(() => {
    if (hasPasskey || busy) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(ENROLL_PASSKEY_PARAM) !== "1") return;
    if (!checkWebauthnHost().ok) return;
    url.searchParams.delete(ENROLL_PASSKEY_PARAM);
    window.history.replaceState(null, "", url);
    void run(() => store.enrollPasskey(), "Passkey unlock enrolled.");
  }, [hasPasskey, busy, store, run]);

  const open = (kind: MethodKind, view: SheetRequest["view"]) => () => {
    setMessage(null);
    setSheet({ kind, view });
  };

  const keyRow = (kind: KeyKind, sub: string, enrolledSub: string) => {
    const on = enrolled.includes(kind);
    return (
      <MethodRow
        kind={kind}
        label={KEY_TITLE[kind]}
        state={on ? "Enrolled" : "Off"}
        on={on}
        sub={on ? enrolledSub : sub}
        action={
          on ? (
            <IconKey
              label={kind === "passkey" ? "Remove" : "Change"}
              small
              keyRef={kind === "password" ? passwordRef : undefined}
              disabled={busy}
              onClick={open(kind, kind === "passkey" ? "remove" : "change")}
            >
              {kind === "passkey" ? (
                <IconTrash size={16} />
              ) : (
                <IconEdit size={16} />
              )}
            </IconKey>
          ) : (
            <IconKey
              label="Add"
              small
              keyRef={kind === "password" ? passwordRef : undefined}
              disabled={busy}
              onClick={open(kind, "add")}
            >
              <IconPlus size={16} />
            </IconKey>
          )
        }
      />
    );
  };

  const codeRow = (channel: CodeChannel, label: string) => {
    const on = secondSteps.includes(channel);
    return (
      <MethodRow
        kind={channel}
        label={label}
        state={!hasIdentity ? "Unavailable" : on ? "On" : "Off"}
        on={on}
        sub={
          !hasIdentity
            ? "Needs a sign-in service to send it."
            : enrolled.length === 0
              ? "After a key."
              : on
                ? "Offered at step 2. Sent by your sign-in service."
                : "For a lost phone. Sent by your sign-in service to an address you confirm."
        }
        action={
          !hasIdentity ? (
            // A route link, not an href: `/settings/capabilities` without the
            // deployment's base path was a full reload onto a 404 on Pages.
            // Drawn as the row's one key, in the column every row's key is.
            <Link
              className="icon-btn icon-btn--sm"
              to="/settings/capabilities"
              aria-label="Set up a sign-in service under Capabilities"
              title="Set up a sign-in service under Capabilities"
            >
              <IconSettings size={16} />
            </Link>
          ) : (
            <IconKey
              label={on ? "Remove" : "Add"}
              small
              disabled={busy || (!on && enrolled.length === 0)}
              onClick={open(channel, on ? "remove" : "add")}
            >
              {on ? <IconTrash size={16} /> : <IconPlus size={16} />}
            </IconKey>
          )
        }
      />
    );
  };

  const totpOn = secondSteps.includes("totp");

  return (
    <>
      <section className="panel set__security">
        <div className="panel__head">
          <div>
            <h2>Unlock methods</h2>
            <p className="hint">
              Which key opens this vault on this device. Keep at least one.
            </p>
          </div>
        </div>
        <div className="panel__body">
          <StatusNote message={message} />
          {/* True only while there is no key behind this vault: enrolling one
              puts the header on disk like any other vault, and the note would
              then be claiming something that is no longer so. */}
          {guest && enrolled.length === 0 ? (
            <output className="note">
              <span>
                You are a guest. Until this vault has a key it is not kept on
                this device. Start with a {webauthnHost.ok ? "passkey" : "PIN"}.
              </span>
            </output>
          ) : null}
          {keyRow(
            "passkey",
            "Face, fingerprint or the device PIN, through this browser.",
            `This browser, ${webauthnHost.hostname}. Face, fingerprint or the device PIN.`,
          )}
          {keyRow(
            "pin",
            "Four to twelve digits, held on this device.",
            "Four to twelve digits, held on this device.",
          )}
          {keyRow(
            "password",
            "Twelve characters or more.",
            header?.hint
              ? "The reminder you saved shows at unlock."
              : "Master password.",
          )}
        </div>
      </section>

      <section className="panel set__security" ref={secondStepRef}>
        <div className="panel__head">
          <div>
            <h2>Second step</h2>
            <p className="hint">
              Asked after the key, every unlock. Nothing turns on until a code
              from the new method matches.
            </p>
          </div>
        </div>
        <div className="panel__body">
          <MethodRow
            kind="totp"
            label="Authenticator app"
            state={totpOn ? "On" : "Off"}
            on={totpOn}
            sub={
              enrolled.length === 0
                ? "After a key. Add sets the key first, then scans."
                : totpOn
                  ? "Codes from the app on your phone."
                  : "Codes from an app on your phone."
            }
            action={
              <IconKey
                label={totpOn ? "Remove" : "Add"}
                small
                disabled={busy}
                onClick={open("totp", totpOn ? "remove" : "add")}
              >
                {totpOn ? <IconTrash size={16} /> : <IconPlus size={16} />}
              </IconKey>
            }
          />
          {codeRow("email", "Email code")}
          {codeRow("sms", "Text message")}
        </div>
      </section>

      <section className="panel set__security" ref={recoveryRef}>
        <div className="panel__head">
          <div>
            <h2>Recovery</h2>
            <p className="hint">
              For the day the phone is gone. {describeRecovery("identity")}
            </p>
          </div>
        </div>
        <div className="panel__body">
          <MethodRow
            kind="recovery"
            label="Recovery codes"
            state={hasRecovery ? "Made" : "None yet"}
            on={hasRecovery}
            sub={
              hasRecovery
                ? "Each stands in for the second step once."
                : "Made with your first second step, and shown once."
            }
            action={
              hasRecovery ? (
                <IconKey
                  label="View recovery codes"
                  small
                  disabled={busy}
                  onClick={open("recovery", "add")}
                >
                  <IconEye size={16} />
                </IconKey>
              ) : null
            }
          />
        </div>
      </section>

      {sheet ? (
        <MethodSheet
          request={sheet}
          enrolled={enrolled}
          host={webauthnHost}
          busy={busy}
          run={run}
          accountEmail={accountEmail}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

/** One row: glyph, name, state chip, one line, one action. Never an input. */
function MethodRow({
  kind,
  label,
  state,
  on,
  sub,
  action,
}: {
  kind: MethodKind;
  label: string;
  state: string;
  on: boolean;
  sub: string;
  action: ReactNode;
}) {
  return (
    <div className="sw sw--method">
      <div>
        <div className="sw__name">
          {methodIcon(kind)}
          {label}
          <StatusMark tone={on ? "ok" : "idle"} label={state} />
        </div>
        <p className="sw__sub">{sub}</p>
      </div>
      {action}
    </div>
  );
}

export type { UnlockMethodId };
