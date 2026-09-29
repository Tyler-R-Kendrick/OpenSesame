export {
  onCompleteUnlockCodeSubmission,
  persistEnrollmentStateForUnlock,
} from "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js";
import { AccountFactorError } from "@opensesame/app-core/lib/account-factors.js";
import { describeRecovery } from "@opensesame/app-core/lib/configuration/recovery-outcomes.js";
import { loadSession } from "@opensesame/app-core/lib/federation.js";
import { readSignInService } from "@opensesame/app-core/lib/identity-service.js";
import { isRemoteIdentityConfigured } from "@opensesame/app-core/lib/identity.js";
import { RemoteCodeError } from "@opensesame/app-core/lib/vault/remote-code.js";
import {
  type UnlockMethodId,
  type WebauthnHostCheck,
  checkWebauthnHost,
  describeWebauthnError,
  listAvailableUnlockMethods,
  listSecondSteps,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { useCallback, useEffect, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconEdit,
  IconEye,
  IconPlus,
  IconTrash,
} from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { AccountFactorsPanel } from "./security/AccountFactorsPanel.js";
import { CodeRows } from "./security/CodeRows.js";
import { KEY_TITLE, type KeyKind } from "./security/KeyCeremony.js";
import { MethodRow } from "./security/MethodRow.js";
import {
  type MethodKind,
  MethodSheet,
  type SheetRequest,
} from "./security/MethodSheet.js";
import type { Run } from "./security/run.js";

const ENROLL_PASSKEY_PARAM = "enroll-passkey";

/**
 * Settings › Security. Three lists — the keys that open this vault, the
 * second steps asked after one, and the recovery codes — each a row of
 * read-only state with exactly one action. No row holds an input: every
 * form lives in the one sheet a row's action opens, so the PIN form exists
 * once, and the authenticator ceremony on a keyless vault reuses it as its
 * step 1 rather than drawing a second one (docs/design/canvases/auth-flow, ADR 0091).
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
  const signInService = readSignInService();
  // A code can only guard a key, so a keyless vault is offered the
  // authenticator (which walks a key first) and nothing it cannot finish.
  const offersCodes = enrolled.length > 0;
  const accountEmail = loadSession()?.email ?? null;

  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  // Bumped when a sheet closes, so the account's rows read the list again.
  const [closed, setClosed] = useState(0);
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
      if (ok !== null) setMessage({ tone: "ok", text: ok });
    } catch (caught) {
      setMessage({
        tone: "err",
        text:
          caught instanceof RemoteCodeError ||
          caught instanceof AccountFactorError
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
  const openAccount = (request: SheetRequest) => {
    setMessage(null);
    setSheet(request);
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

  const totpOn = secondSteps.includes("totp");

  return (
    <>
      <section className="panel set__security" id="unlock-methods">
        <div className="panel__head">
          <div>
            <h2>Unlock methods</h2>
            <p className="hint">
              Which key opens this vault on this device. Keep at least one.{" "}
              {describeRecovery("identity")}
            </p>
          </div>
        </div>
        <div className="panel__body">
          <StatusNote message={message} />
          {/* True only while there is no key behind this vault: enrolling one
              puts the header on disk like any other vault, and the note would
              then be claiming something that is no longer so. */}
          {guest && enrolled.length === 0 ? (
            // A line in the list's own voice, not a boxed note pressed
            // against the first row (DESIGN.md: no in-page note box).
            <p className="hint">
              You are a guest. Until this vault has a key it is not kept on this
              device. Start with a {webauthnHost.ok ? "passkey" : "PIN"}.
            </p>
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

      <section
        className="panel set__security"
        id="second-step"
        ref={secondStepRef}
      >
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
          {offersCodes ? (
            <CodeRows
              secondSteps={secondSteps}
              hasService={hasIdentity}
              service={signInService}
              busy={busy}
              open={open}
            />
          ) : null}
        </div>
      </section>

      {hasRecovery ? (
        <section
          className="panel set__security"
          id="recovery"
          ref={recoveryRef}
        >
          <div className="panel__head">
            <div>
              <h2>Recovery</h2>
              <p className="hint">For the day the phone is gone.</p>
            </div>
          </div>
          <div className="panel__body">
            <MethodRow
              kind="recovery"
              label="Recovery codes"
              state="Made"
              on
              sub="Each stands in for the second step once."
              action={
                <IconKey
                  label="View recovery codes"
                  small
                  disabled={busy}
                  onClick={open("recovery", "add")}
                >
                  <IconEye size={16} />
                </IconKey>
              }
            />
          </div>
        </section>
      ) : null}

      <AccountFactorsPanel busy={busy} closed={closed} onOpen={openAccount} />

      {sheet ? (
        <MethodSheet
          request={sheet}
          enrolled={enrolled}
          host={webauthnHost}
          busy={busy}
          run={run}
          accountEmail={accountEmail}
          onClose={() => {
            setSheet(null);
            setClosed((n) => n + 1);
          }}
        />
      ) : null}
    </>
  );
}

export type { UnlockMethodId };
