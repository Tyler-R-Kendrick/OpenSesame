export {
  onCompleteUnlockCodeSubmission,
  persistEnrollmentStateForUnlock,
} from "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js";
import { AccountFactorError } from "@opensesame/app-core/lib/account-factors.js";
import { describeRecovery } from "@opensesame/app-core/lib/configuration/recovery-outcomes.js";
import { loadSession } from "@opensesame/app-core/lib/federation.js";
import { readSignInService } from "@opensesame/app-core/lib/identity-service.js";
import { isRemoteIdentityConfigured } from "@opensesame/app-core/lib/identity.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
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
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { AccountFactorsPanel } from "./security/AccountFactorsPanel.js";
import { CodeRows } from "./security/CodeRows.js";
import { GuestAfterKeyRows } from "./security/GuestAfterKeyRows.js";
import { KEY_TITLE, type KeyKind } from "./security/KeyCeremony.js";
import { MethodRow } from "./security/MethodRow.js";
import {
  type MethodKind,
  MethodSheet,
  type SheetRequest,
} from "./security/MethodSheet.js";
import type { Run } from "./security/run.js";

const ENROLL_PASSKEY_PARAM = "enroll-passkey";
const NOTICE_ID = "unlock-methods";

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
  const { header, guest, decoy } = useVault();
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

  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  // Bumped when a sheet closes, so the account's rows read the list again.
  const [closed, setClosed] = useState(0);
  const [webauthnHost, setWebauthnHost] = useState<WebauthnHostCheck>(() =>
    checkWebauthnHost(),
  );
  const secondStepRef = useGuideTarget<HTMLElement>("settings.second-step");
  const recoveryRef = useGuideTarget<HTMLElement>("settings.recovery");

  useEffect(() => {
    setWebauthnHost(checkWebauthnHost());
  }, []);

  // What an action did shows where it can be read: a success is the row's own
  // state (a ceremony's card says the rest) and is only announced; a failure
  // is a notice in the tray — never a box in the page, behind the sheet that
  // asked (DESIGN.md).
  const run = useCallback<Run>(async (action, ok) => {
    dismissNotice(NOTICE_ID);
    setSaid("");
    setBusy(true);
    try {
      await action();
      if (ok !== null) setSaid(ok);
    } catch (caught) {
      setStatusNotice({
        id: NOTICE_ID,
        tone: "err",
        title: "Unlock methods",
        body:
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
    dismissNotice(NOTICE_ID);
    setSheet({ kind, view });
  };
  const openAccount = (request: SheetRequest) => {
    dismissNotice(NOTICE_ID);
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
              label={kind === "pin" ? "Change" : "Remove"}
              small
              disabled={busy}
              onClick={open(
                kind,
                kind === "passkey" || kind === "password" ? "remove" : "change",
              )}
            >
              {kind === "pin" ? (
                <IconEdit size={16} />
              ) : (
                <IconTrash size={16} />
              )}
            </IconKey>
          ) : (
            <IconKey
              label="Add"
              small
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
            {/* The one sentence that is a security boundary, not an
                explainer: signing in again through the identity provider
                never opens the vault (J-RECOVERY). */}
            <p className="hint">{describeRecovery("identity")}</p>
          </div>
        </div>
        <div className="panel__body">
          <output className="visually-hidden" aria-live="polite">
            {said}
          </output>
          {/* True only while there is no key behind this vault: enrolling one
              puts the header on disk like any other vault, and the note would
              then be claiming something that is no longer so. */}
          {guest && !decoy && enrolled.length === 0 ? (
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
          {/* A master password is never added or changed (ADR 0180). A vault
              that already holds one keeps its row, so it can be removed once
              a passkey is in place — and only then. */}
          {enrolled.includes("password")
            ? keyRow(
                "password",
                "",
                header?.hint
                  ? "The reminder you saved shows at unlock."
                  : "Master password.",
              )
            : null}
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

      {/* The two sections an owner has below, for a guest who has not made a
          key yet: Add opens the key sheet, the same road the page's first
          line points at. Never in a decoy, which is also a guest. */}
      {guest && !decoy && enrolled.length === 0 ? (
        <GuestAfterKeyRows
          busy={busy}
          onAddKey={open(webauthnHost.ok ? "passkey" : "pin", "add")}
        />
      ) : null}

      {hasRecovery ? (
        <section
          className="panel set__security"
          id="recovery"
          ref={recoveryRef}
        >
          <div className="panel__head">
            <div>
              <h2>Recovery</h2>
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
