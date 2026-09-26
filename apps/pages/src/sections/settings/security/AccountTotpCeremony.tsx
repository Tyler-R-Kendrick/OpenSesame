import {
  abandonAccountTotp,
  beginAccountTotp,
  confirmAccountTotp,
} from "@opensesame/app-core/lib/account-factors.js";
import {
  digitsOf,
  secretOf,
} from "@opensesame/app-core/sections/settings/security/second-step-ceremonies-model.js";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type CeremonyAlt,
  CeremonyAlts,
  CeremonyShell,
} from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconCopy, IconPhone, IconSecret } from "../../../components/Icons.js";
import { QrCode } from "../../../components/QrCode.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { Rail } from "./SecondStepCeremonies.js";
import type { Run } from "./run.js";

/**
 * The account's authenticator app, set up in the one Security sheet: scan,
 * then a code that matches (ADR 0140 D10). The Identity API writes the seed
 * when it makes it, so a setup closed before a code matched is removed —
 * nobody is left with a factor never scanned.
 */

type Stage = "scan" | "confirm" | "done";

const FOOTS = {
  scan: "Until a code matches, closing this sheet removes the setup.",
  confirm:
    "A bad scan cannot lock you out: nothing is kept until a code matches.",
  done: "Your sign-in service asks for this code; the vault does not.",
} satisfies Record<Stage, string>;

export function AccountTotpCeremony({
  busy,
  run,
  onDone,
  setFoot,
}: {
  busy: boolean;
  run: Run;
  onDone: () => void;
  setFoot: (foot: string | null) => void;
}) {
  const [stage, setStage] = useState<Stage>("scan");
  const [uri, setUri] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const began = useRef(false);
  const issued = useRef<string | null>(null);
  const confirmed = useRef(false);

  useEffect(() => {
    if (began.current) return;
    began.current = true;
    void run(async () => {
      try {
        const link = await beginAccountTotp();
        issued.current = link;
        setUri(link);
      } catch (error) {
        setRefusal(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }, "Scan the code with your authenticator, then enter the code it shows.");
  }, [run]);

  useEffect(() => {
    return () => {
      // The seed still in memory proves its own removal (ADR 0146).
      if (issued.current && !confirmed.current) {
        void abandonAccountTotp(issued.current).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    setFoot(FOOTS[stage]);
  }, [stage, setFoot]);

  const rail = (
    <Rail steps={["Scan", "Confirm"]} now={stage === "scan" ? 0 : 1} />
  );
  if (stage === "scan") {
    return (
      <>
        {rail}
        <TotpScanCard
          uri={uri}
          refusal={refusal}
          busy={busy}
          onScanned={() => setStage("confirm")}
        />
      </>
    );
  }
  if (stage === "confirm") {
    return (
      <>
        {rail}
        <TotpConfirmCard
          busy={busy}
          run={run}
          onConfirmed={() => {
            confirmed.current = true;
            setStage("done");
          }}
        />
      </>
    );
  }
  return (
    <CeremonyShell
      ok
      top="Authenticator on"
      name="Your sign-in service asks for its code"
      facts={[{ key: "Vault", value: "untouched; its keys are unchanged" }]}
      primary={{ label: "Done", onClick: onDone }}
    />
  );
}

function TotpScanCard({
  uri,
  refusal,
  busy,
  onScanned,
}: {
  uri: string | null;
  refusal: string | null;
  busy: boolean;
  onScanned: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const secret = uri ? secretOf(uri) : "";
  const copyLabel = copied ? "Copied" : "Copy setup key";
  const alts: CeremonyAlt[] = uri
    ? [
        {
          id: "manual",
          label: "Can't scan? Type the key instead",
          icon: <IconSecret size={16} />,
          render: () => (
            <FieldShell
              label="Setup key"
              value={secret.replace(/(.{4})/g, "$1 ").trim()}
              readOnly
              mono
              tail={
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={copyLabel}
                  title={copyLabel}
                  onClick={() =>
                    void navigator.clipboard.writeText(secret).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    )
                  }
                >
                  <IconCopy size={18} />
                </button>
              }
            />
          ),
        },
      ]
    : [];
  return (
    <>
      <CeremonyShell
        ok={refusal === null}
        name="OpenSesame · your account"
        facts={[
          {
            key: "Scan with",
            value: "Google Authenticator, 1Password, Aegis, Authy",
          },
          { key: "Codes", value: "6 digits, every 30 s" },
        ]}
        primary={
          refusal === null
            ? {
                label: "I scanned it",
                disabled: uri === null,
                busy,
                onClick: onScanned,
              }
            : undefined
        }
      >
        {uri ? (
          <QrCode
            value={uri}
            label="Scan to add your account's authenticator"
            size={168}
          />
        ) : (
          <p className="hint">{refusal ?? "Making the seed…"}</p>
        )}
      </CeremonyShell>
      <CeremonyAlts alts={alts} />
    </>
  );
}

function TotpConfirmCard({
  busy,
  run,
  onConfirmed,
}: {
  busy: boolean;
  run: Run;
  onConfirmed: () => void;
}) {
  const [code, setCode] = useState("");
  const [refused, setRefused] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (digitsOf(code).length < 6) return;
    setRefused(false);
    void run(async () => {
      try {
        await confirmAccountTotp(code);
      } catch (error) {
        setRefused(true);
        throw error;
      }
      setCode("");
      onConfirmed();
    }, "Authenticator on for your account.");
  };
  return (
    <form onSubmit={submit} aria-label="Confirm account authenticator code">
      <CeremonyShell
        ok
        name="Code from the app"
        primary={{
          label: "Turn on",
          submit: true,
          disabled: digitsOf(code).length < 6,
          busy,
          onClick: () => {},
        }}
      >
        <FieldShell
          label="Six digits"
          value={code}
          onValueChange={(next) => {
            setCode(next);
            setRefused(false);
          }}
          autoComplete="one-time-code"
          inputMode="numeric"
          placeholder="000 000"
          lead={<IconPhone size={16} />}
          mono
          disabled={busy}
          status={
            refused ? <StatusMark tone="err" label="Did not match" /> : null
          }
        />
      </CeremonyShell>
    </form>
  );
}
