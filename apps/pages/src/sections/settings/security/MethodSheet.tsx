import { type ReactNode, useRef, useState } from "react";
import {
  IconMail,
  IconMessage,
  IconPhone,
  IconSecret,
  IconX,
} from "../../../components/Icons.js";
import { useModalFocus } from "../../../lib/modal-focus.js";
import type {
  CodeChannel,
  UnlockMethodId,
  WebauthnHostCheck,
} from "../../../lib/vault/unlock-methods.js";
import {
  KEY_SUBTITLE,
  KEY_TITLE,
  KeyCeremony,
  type KeyKind,
  type KeyView,
  keyIcon,
} from "./KeyCeremony.js";
import {
  AuthenticatorCeremony,
  CodeCeremony,
  RecoveryCeremony,
} from "./SecondStepCeremonies.js";
import type { Run } from "./run.js";

export type MethodKind = KeyKind | "totp" | CodeChannel | "recovery";
export type MethodView = KeyView;

/** What a row's action asked for: which method, and to do what with it. */
export type SheetRequest = { kind: MethodKind; view: MethodView };

const TITLE = {
  ...KEY_TITLE,
  totp: "Authenticator app",
  email: "Email code",
  sms: "Text message code",
  recovery: "Recovery codes",
} satisfies Record<MethodKind, string>;

const SUBTITLE = {
  ...KEY_SUBTITLE,
  totp: "Codes from an app on your phone. The seed is sealed under the vault key.",
  email: "For a lost phone. Sent by the Identity API.",
  sms: "For a lost phone. Sent by the Identity API.",
  recovery: "Each stands in for the second step once.",
} satisfies Record<MethodKind, string>;

export function methodIcon(kind: MethodKind, size = 16): ReactNode {
  switch (kind) {
    case "totp":
      return <IconPhone size={size} />;
    case "email":
      return <IconMail size={size} />;
    case "sms":
      return <IconMessage size={size} />;
    case "recovery":
      return <IconSecret size={size} />;
    default:
      return keyIcon(kind, size);
  }
}

/**
 * The one sheet every method is added, changed or removed in — the side
 * sheet the Connectivity bar already opens, with a CeremonyShell card
 * inside. A row's action names what the sheet will do; the sheet's foot
 * says what is and is not written yet (docs/design/auth-flow).
 */
export function MethodSheet({
  request,
  enrolled,
  host,
  busy,
  run,
  accountEmail,
  onClose,
}: {
  request: SheetRequest;
  enrolled: UnlockMethodId[];
  host: WebauthnHostCheck;
  busy: boolean;
  run: Run;
  /** The signed-in account's address, offered as a fill — never pre-filled. */
  accountEmail: string | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const [foot, setFoot] = useState<string | null>(null);
  const { kind, view } = request;

  let body: ReactNode;
  if (kind === "passkey" || kind === "pin" || kind === "password") {
    body = (
      <KeyCeremony
        kind={kind}
        view={view}
        enrolled={enrolled}
        host={host}
        busy={busy}
        run={run}
        onDone={onClose}
      />
    );
  } else if (kind === "totp") {
    body = (
      <AuthenticatorCeremony
        view={view}
        enrolled={enrolled}
        host={host}
        busy={busy}
        run={run}
        onDone={onClose}
        setFoot={setFoot}
      />
    );
  } else if (kind === "recovery") {
    body = <RecoveryCeremony busy={busy} run={run} setFoot={setFoot} />;
  } else {
    body = (
      <CodeCeremony
        channel={kind}
        view={view}
        busy={busy}
        run={run}
        accountEmail={accountEmail}
        onDone={onClose}
        setFoot={setFoot}
      />
    );
  }

  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label={TITLE[kind]}
        aria-modal="true"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            {methodIcon(kind, 20)}
          </span>
          <div className="sheet__grow">
            <h2>{TITLE[kind]}</h2>
            <p>{SUBTITLE[kind]}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            ref={closeRef}
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">{body}</div>
        <div className="sheet__foot">
          <p className="hint">{foot ?? footFor(kind, view)}</p>
        </div>
      </div>
    </div>
  );
}

function footFor(kind: MethodKind, view: MethodView): string {
  if (view === "remove") {
    return kind === "passkey" || kind === "pin" || kind === "password"
      ? "Removing a key does not touch the vault; it only stops opening it. The other keys keep working."
      : "Nothing else changes. Your keys keep working.";
  }
  if (view === "change") {
    return "The old one stops working the moment the new one is set.";
  }
  switch (kind) {
    case "totp":
      return "The seed lives only in memory until a code matches.";
    case "email":
    case "sms":
      return "The Identity API sends the code. The vault key never leaves this device.";
    case "recovery":
      return "Sealed under the vault key. A used code is crossed out here and refused at unlock.";
    default:
      return "Nothing changes until you press the button in the card. The vault stays unlocked while you do this.";
  }
}
