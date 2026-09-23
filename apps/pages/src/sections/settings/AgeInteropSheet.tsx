import { generateAgeKeyPair } from "@opensesame/app-core/lib/age-keys.js";
import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import {
  exportAgeArmored,
  importAgeArmored,
} from "@opensesame/app-core/lib/vault/protection/sops-browser.js";
import { type RefObject, useRef, useState } from "react";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconPlus, IconX } from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";

function formatsNotice(tone: "info" | "err", body: string): void {
  setStatusNotice({
    id: "formats-interoperability",
    tone,
    title: "Formats",
    body,
  });
}

function AgeInteropFields({
  plaintext,
  recipient,
  armored,
  identity,
  busy,
  setPlaintext,
  setRecipient,
  setArmored,
  setIdentity,
  onMint,
}: {
  plaintext: string;
  recipient: string;
  armored: string;
  identity: string;
  busy: boolean;
  setPlaintext: (value: string) => void;
  setRecipient: (value: string) => void;
  setArmored: (value: string) => void;
  setIdentity: (value: string) => void;
  onMint: () => void;
}) {
  return (
    <>
      <FieldShell
        label="Plaintext"
        value={plaintext}
        onValueChange={setPlaintext}
      />
      <FieldShell
        label="Recipient"
        value={recipient}
        onValueChange={setRecipient}
        mono
      />
      <FieldShell
        label="Armored ciphertext"
        value={armored}
        onValueChange={setArmored}
        mono
      />
      <FieldShell
        label="Identity"
        type="password"
        value={identity}
        onValueChange={setIdentity}
        mono
      />
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Mint age key pair"
        title="Mint age key pair"
        disabled={busy}
        onClick={onMint}
      >
        <IconPlus size={16} />
      </button>
    </>
  );
}

type AgeInteropSheetViewProps = {
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
  sheetRef: RefObject<HTMLDivElement | null>;
  plaintext: string;
  recipient: string;
  armored: string;
  identity: string;
  busy: boolean;
  setPlaintext: (value: string) => void;
  setRecipient: (value: string) => void;
  setArmored: (value: string) => void;
  setIdentity: (value: string) => void;
  onEncrypt: () => void;
  onDecrypt: () => void;
  onMint: () => void;
};

function AgeInteropSheetView(props: AgeInteropSheetViewProps) {
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={props.onClose}
      />
      <div
        ref={props.sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: dialog sheet pattern
        role="dialog"
        aria-label="age"
        aria-modal="true"
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>age</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            ref={props.closeRef}
            onClick={props.onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">
          <CeremonyShell
            ok
            name="age armor"
            primary={{
              label: "Encrypt",
              busy: props.busy,
              disabled: props.busy || !props.plaintext || !props.recipient,
              onClick: props.onEncrypt,
            }}
            secondary={{
              label: "Decrypt",
              busy: props.busy,
              disabled: props.busy || !props.armored || !props.identity,
              onClick: props.onDecrypt,
            }}
          >
            <AgeInteropFields
              plaintext={props.plaintext}
              recipient={props.recipient}
              armored={props.armored}
              identity={props.identity}
              busy={props.busy}
              setPlaintext={props.setPlaintext}
              setRecipient={props.setRecipient}
              setArmored={props.setArmored}
              setIdentity={props.setIdentity}
              onMint={props.onMint}
            />
          </CeremonyShell>
        </div>
      </div>
    </div>
  );
}

export function AgeInteropSheet({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const [plaintext, setPlaintext] = useState("");
  const [recipient, setRecipient] = useState("");
  const [armored, setArmored] = useState("");
  const [identity, setIdentity] = useState("");
  const [busy, setBusy] = useState(false);

  const onEncrypt = () => {
    setBusy(true);
    void (async () => {
      try {
        const out = await exportAgeArmored(
          new TextEncoder().encode(plaintext),
          [recipient],
        );
        setArmored(out);
        formatsNotice("info", "age ciphertext ready.");
      } catch (caught) {
        formatsNotice(
          "err",
          caught instanceof Error ? caught.message : "age encrypt failed.",
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const onDecrypt = () => {
    setBusy(true);
    void (async () => {
      try {
        const opened = await importAgeArmored(armored, identity);
        setPlaintext(new TextDecoder().decode(opened));
        formatsNotice("info", "age plaintext recovered.");
      } catch (caught) {
        formatsNotice(
          "err",
          caught instanceof Error ? caught.message : "age decrypt failed.",
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <AgeInteropSheetView
      onClose={onClose}
      closeRef={closeRef}
      sheetRef={sheetRef}
      plaintext={plaintext}
      recipient={recipient}
      armored={armored}
      identity={identity}
      busy={busy}
      setPlaintext={setPlaintext}
      setRecipient={setRecipient}
      setArmored={setArmored}
      setIdentity={setIdentity}
      onEncrypt={onEncrypt}
      onDecrypt={onDecrypt}
      onMint={() => {
        setBusy(true);
        void (async () => {
          try {
            const pair = await generateAgeKeyPair();
            setRecipient(pair.recipient);
            setIdentity(pair.identity);
          } finally {
            setBusy(false);
          }
        })();
      }}
    />
  );
}
