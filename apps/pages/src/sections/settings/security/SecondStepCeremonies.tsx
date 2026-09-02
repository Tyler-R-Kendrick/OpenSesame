import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type CeremonyAlt,
  CeremonyAlts,
  CeremonyShell,
} from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import {
  IconAlert,
  IconCopy,
  IconDownload,
  IconEdit,
  IconMail,
  IconMessage,
  IconPhone,
  IconRefresh,
  IconSecret,
} from "../../../components/Icons.js";
import { QrCode } from "../../../components/QrCode.js";
import { identityBase } from "../../../lib/identity.js";
import { useVault, useVaultStore } from "../../../lib/vault/hooks.js";
import type { SentCode } from "../../../lib/vault/remote-code.js";
import {
  type CodeChannel,
  type UnlockMethodId,
  type WebauthnHostCheck,
  listSecondSteps,
} from "../../../lib/vault/unlock-methods.js";
import { KeyCeremony } from "./KeyCeremony.js";
import type { Run } from "./run.js";

type Setter = (foot: string | null) => void;

function digitsOf(code: string): string {
  return code.replace(/\s/g, "");
}

/* ------------------------------------------------------------------ *
 * Recovery codes — shown once when the first second step turns on, and
 * again from the Recovery row while the vault is open.
 * ------------------------------------------------------------------ */

/** Which codes exist and which are spent. */
type Codes = { codes: string[]; used: boolean[] };
type Ledger = Codes & { since: string };

function CodesList({ codes, used }: { codes: string[]; used: boolean[] }) {
  return (
    <ol className="codes" aria-label="Recovery codes">
      {codes.map((code, i) => (
        <li key={code} className={used[i] ? "is-used" : undefined}>
          {code}
        </li>
      ))}
    </ol>
  );
}

function unusedText(ledger: Codes): string {
  return ledger.codes
    .filter((_, i) => !ledger.used[i])
    .join("\n")
    .concat("\n");
}

async function copyCodes(ledger: Codes): Promise<void> {
  await navigator.clipboard.writeText(unusedText(ledger));
}

function downloadCodes(ledger: Codes): void {
  const url = URL.createObjectURL(
    new Blob([`OpenSesame vault recovery codes\n\n${unusedText(ledger)}`], {
      type: "text/plain",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "opensesame-recovery-codes.txt";
  a.click();
  URL.revokeObjectURL(url);
}

/** The card that hands over fresh codes: copy, download, and "I saved them". */
function FreshCodes({
  codes,
  top,
  onDone,
}: {
  codes: string[];
  top: string;
  onDone: () => void;
}) {
  const ledger = { codes, used: codes.map(() => false) };
  const [copied, setCopied] = useState(false);
  return (
    <CeremonyShell
      ok
      top={top}
      name="Recovery codes · shown once"
      facts={[
        { key: "Asked", value: "after the key, every unlock" },
        {
          key: "Each code",
          value: "opens the vault once if the phone is gone",
        },
      ]}
      primary={{ label: "I saved them", onClick: onDone }}
    >
      <CodesList codes={codes} used={ledger.used} />
      {/* Copy and Download come before the commit: save first, then say so. */}
      <div className="actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            void copyCodes(ledger).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          <IconCopy size={16} /> {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => downloadCodes(ledger)}
        >
          <IconDownload size={16} /> Download
        </button>
      </div>
    </CeremonyShell>
  );
}

export function RecoveryCeremony({
  busy,
  run,
  setFoot,
}: {
  busy: boolean;
  run: Run;
  setFoot: Setter;
}) {
  const store = useVaultStore();
  const [ledger, setLedger] = useState<Ledger | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [fresh, setFresh] = useState<string[] | null>(null);

  useEffect(() => {
    let live = true;
    void store.recoveryCodes().then(
      (loaded) => {
        if (live) setLedger(loaded);
      },
      () => {
        if (live) setLedger(null);
      },
    );
    return () => {
      live = false;
    };
  }, [store]);

  if (fresh) {
    return (
      <FreshCodes
        codes={fresh}
        top="New set made"
        onDone={() => {
          setFresh(null);
          setLedger({
            codes: fresh,
            used: fresh.map(() => false),
            since: new Date().toISOString(),
          });
        }}
      />
    );
  }
  if (ledger === undefined) {
    return <p className="hint">Opening the sealed codes…</p>;
  }
  if (ledger === null) {
    return (
      <CeremonyShell
        ok={false}
        top="None yet"
        name="Made with your first second step"
      >
        <p className="hint">
          Add an authenticator, email or text code; the codes are shown once
          when it turns on, and again here.
        </p>
      </CeremonyShell>
    );
  }
  const left = ledger.used.filter((flag) => !flag).length;
  const alts: CeremonyAlt[] = [
    {
      id: "regenerate",
      label: "Make a new set",
      icon: <IconRefresh size={16} />,
      render: () => (
        <>
          <p className="hint">
            A new set replaces this one whole; the old codes stop working the
            moment it is made.
          </p>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={() => {
              setFoot("The old codes stopped working. Save the new ones.");
              void run(async () => {
                setFresh(await store.generateRecoveryCodes());
              }, "A new set of recovery codes was made.");
            }}
          >
            Make a new set
          </button>
        </>
      ),
    },
  ];
  return (
    <>
      <CeremonyShell
        ok
        top={`${left} of ${ledger.codes.length} left`}
        name={`Made ${new Date(ledger.since).toLocaleDateString()}`}
        primary={{
          label: copied ? "Copied" : "Copy",
          onClick: () =>
            void copyCodes(ledger).then(
              () => setCopied(true),
              () => setCopied(false),
            ),
        }}
        secondary={{ label: "Download", onClick: () => downloadCodes(ledger) }}
      >
        <CodesList codes={ledger.codes} used={ledger.used} />
      </CeremonyShell>
      <CeremonyAlts alts={alts} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Authenticator app
 * ------------------------------------------------------------------ */

type TotpStage = "key" | "scan" | "confirm" | "done";

function Rail({
  steps,
  now,
}: {
  steps: string[];
  now: number;
}) {
  return (
    <div className="steps" aria-label="Enrollment steps">
      {steps.map((label, i) => (
        <div
          key={label}
          className={
            i < now
              ? "steps__seg is-done"
              : i === now
                ? "steps__seg is-now"
                : "steps__seg"
          }
        >
          <span className="steps__bar" />
          <span className="steps__label">
            {i + 1} · {label}
          </span>
        </div>
      ))}
    </div>
  );
}

function secretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export function AuthenticatorCeremony({
  view,
  enrolled,
  host,
  busy,
  run,
  onDone,
  setFoot,
}: {
  view: "add" | "change" | "remove";
  enrolled: UnlockMethodId[];
  host: WebauthnHostCheck;
  busy: boolean;
  run: Run;
  onDone: () => void;
  setFoot: Setter;
}) {
  const store = useVaultStore();
  const { header } = useVault();
  // The rail is the whole ceremony, said before any step is taken — so a
  // vault that had no key when the sheet opened keeps its Key segment (done)
  // once the key exists, rather than renumbering the steps mid-way.
  const [needsKey] = useState(enrolled.length === 0);
  const hasKey = enrolled.length > 0;
  const [stage, setStage] = useState<TotpStage>(
    view === "remove" ? "done" : needsKey ? "key" : "scan",
  );
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [refused, setRefused] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const began = useRef(false);

  // The moment the key exists, the scan begins on its own: the person came
  // for the authenticator, and the key was the prerequisite, not the goal.
  useEffect(() => {
    if (view === "remove" || busy) return;
    if (stage === "key" && hasKey) setStage("scan");
    if (stage === "scan" && uri === null && !began.current) {
      began.current = true;
      void run(async () => {
        setUri(await store.beginTotpEnrollment());
      }, "Scan the code with your authenticator, then enter the code it shows.");
    }
  }, [view, busy, stage, hasKey, uri, run, store]);

  // Close the sheet mid-way and nothing is kept.
  useEffect(() => {
    return () => {
      if (view !== "remove") store.cancelTotpEnrollment();
    };
  }, [view, store]);

  useEffect(() => {
    if (view !== "remove") return;
    void store.recoveryCodes().then(
      (ledger) =>
        setLeft(ledger ? ledger.used.filter((flag) => !flag).length : null),
      () => setLeft(null),
    );
  }, [view, store]);

  useEffect(() => {
    const foots = {
      key: "The code is asked for after this key. Nothing is written yet.",
      scan: "The seed lives only in memory until a code matches.",
      confirm:
        "Nothing is written until a code matches. A bad scan cannot lock you out.",
      done: "The codes are sealed under the vault key. Settings › Security › Recovery shows the ones left.",
    } satisfies Record<TotpStage, string>;
    setFoot(view === "remove" ? null : foots[stage]);
  }, [view, stage, setFoot]);

  if (view === "remove") {
    const lastStep = listSecondSteps(header).length < 2;
    const facts = [
      { key: "After", value: "unlock stops asking for a code" },
      ...(lastStep && left !== null
        ? [{ key: "Recovery", value: `the ${left} unused codes are discarded` }]
        : []),
      { key: "Vault", value: "untouched; your keys keep working" },
    ];
    return (
      <CeremonyShell
        ok={false}
        top="Remove the authenticator?"
        name="Authenticator app"
        facts={facts}
        primary={{
          label: "Remove authenticator",
          tone: "danger",
          busy,
          onClick: () =>
            void run(async () => {
              await store.removeTotp();
              onDone();
            }, "Authenticator removed. Unlock no longer asks for a code."),
        }}
        secondary={{ label: "Keep it", onClick: onDone }}
      />
    );
  }

  const steps = needsKey ? ["Key", "Scan", "Confirm"] : ["Scan", "Confirm"];
  const now =
    stage === "key"
      ? 0
      : stage === "scan"
        ? steps.length - 2
        : steps.length - 1;
  const rail = <Rail steps={steps} now={Math.min(now, steps.length - 1)} />;

  if (stage === "key") {
    return (
      <>
        {rail}
        <KeyCeremony
          kind={host.ok ? "passkey" : "pin"}
          view="add"
          enrolled={enrolled}
          host={host}
          busy={busy}
          run={run}
          onDone={() => {}}
          reason="authenticator"
        />
      </>
    );
  }

  if (stage === "scan") {
    const secret = uri ? secretOf(uri) : "";
    const alts: CeremonyAlt[] = uri
      ? [
          {
            id: "manual",
            label: "Can't scan? Type the key instead",
            icon: <IconSecret size={16} />,
            render: () => (
              <>
                <FieldShell
                  label="Setup key"
                  value={secret.replace(/(.{4})/g, "$1 ").trim()}
                  readOnly
                  mono
                  tail={
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={copiedKey ? "Copied" : "Copy setup key"}
                      onClick={() =>
                        void navigator.clipboard.writeText(secret).then(
                          () => setCopiedKey(true),
                          () => setCopiedKey(false),
                        )
                      }
                    >
                      <IconCopy size={18} />
                    </button>
                  }
                />
                <p className="hint">
                  Time-based, SHA-1, 6 digits, 30 seconds. Account name:
                  OpenSesame vault.
                </p>
              </>
            ),
          },
        ]
      : [];
    return (
      <>
        {rail}
        <CeremonyShell
          ok
          name="OpenSesame · this vault"
          facts={[
            {
              key: "Scan with",
              value: "Google Authenticator, 1Password, Aegis, Authy",
            },
            { key: "Codes", value: "6 digits, every 30 s" },
          ]}
          primary={{
            label: "I scanned it",
            disabled: uri === null,
            busy,
            onClick: () => setStage("confirm"),
          }}
        >
          {uri ? (
            <QrCode value={uri} label="Scan to add vault MFA" size={168} />
          ) : (
            <p className="hint">Making the seed…</p>
          )}
        </CeremonyShell>
        <CeremonyAlts alts={alts} />
      </>
    );
  }

  if (stage === "confirm") {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (digitsOf(code).length < 6) return;
      setRefused(false);
      void run(async () => {
        try {
          await store.confirmTotpEnrollment(code);
        } catch (error) {
          setRefused(true);
          throw error;
        }
        setCode("");
        const existing = await store.recoveryCodes();
        setCodes(existing ? null : await store.generateRecoveryCodes());
        setStage("done");
      }, "Authenticator on. Every unlock now asks for a code.");
    };
    const alts: CeremonyAlt[] = [
      {
        id: "rescan",
        label: "Scan again",
        icon: <IconRefresh size={16} />,
        render: () => (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              store.cancelTotpEnrollment();
              began.current = false;
              setUri(null);
              setCode("");
              setRefused(false);
              setStage("scan");
            }}
          >
            <IconRefresh size={16} /> Make a new seed and scan it
          </button>
        ),
      },
    ];
    return (
      <>
        {rail}
        <form onSubmit={submit} aria-label="Confirm authenticator code">
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
                refused ? (
                  <span className="chip chip--err">Did not match</span>
                ) : null
              }
            />
            {refused ? (
              <p className="hint">
                Codes change every 30 seconds; enter the one showing now. If
                they never match, the phone's clock may be off.
              </p>
            ) : null}
          </CeremonyShell>
        </form>
        <CeremonyAlts alts={alts} />
      </>
    );
  }

  return codes ? (
    <FreshCodes codes={codes} top="Authenticator on" onDone={onDone} />
  ) : (
    <CeremonyShell
      ok
      top="Authenticator on"
      name="Every unlock now asks for a code after the key"
      facts={[
        { key: "Recovery", value: "the codes you already have still stand" },
      ]}
      primary={{ label: "Done", onClick: onDone }}
    />
  );
}

/* ------------------------------------------------------------------ *
 * A code by email or text — the fallback second step
 * ------------------------------------------------------------------ */

type CodeStage = "where" | "confirm" | "done";

const RESEND_COOLDOWN_MS = 30_000;

function channelWords(channel: CodeChannel) {
  return channel === "email"
    ? {
        name: "Email",
        tab: "Email",
        medium: "email",
        fieldLabel: "Email address",
        icon: <IconMail size={16} />,
        notice:
          "A code by email is a fallback, not a first second step: anyone who can read your inbox can read it. Keep an authenticator app or passkey enrolled too.",
        change: "Use a different address",
      }
    : {
        name: "Text message",
        tab: "Text",
        medium: "text",
        fieldLabel: "Phone number",
        icon: <IconMessage size={16} />,
        notice:
          "A code by text is a fallback, not a first second step: a number can be moved to another SIM without you. Keep an authenticator app or passkey enrolled too.",
        change: "Use a different number",
      };
}

function looksLikeAddress(channel: CodeChannel, to: string): boolean {
  return channel === "email"
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())
    : /^\+[1-9]\d{6,14}$/.test(to.replace(/[\s()-]/g, ""));
}

function identityHost(): string {
  try {
    return new URL(identityBase()).host;
  } catch {
    return "your Identity API";
  }
}

export function CodeCeremony({
  channel,
  view,
  busy,
  run,
  accountEmail,
  onDone,
  setFoot,
}: {
  channel: CodeChannel;
  view: "add" | "change" | "remove";
  busy: boolean;
  run: Run;
  accountEmail: string | null;
  onDone: () => void;
  setFoot: Setter;
}) {
  const store = useVaultStore();
  const { header } = useVault();
  const words = channelWords(channel);
  const [stage, setStage] = useState<CodeStage>("where");
  const [to, setTo] = useState("");
  const [sent, setSent] = useState<SentCode | null>(null);
  const [code, setCode] = useState("");
  const [refused, setRefused] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [sentAt, setSentAt] = useState(0);
  const [tick, setTick] = useState(0);
  const [masked, setMasked] = useState<string | null>(null);

  useEffect(() => {
    if (stage !== "confirm") return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  useEffect(() => {
    return () => {
      if (view !== "remove") store.cancelCodeEnrollment();
    };
  }, [view, store]);

  useEffect(() => {
    if (view !== "remove") return;
    void store
      .describeCodeChannel(channel)
      .then(setMasked, () => setMasked(null));
  }, [view, channel, store]);

  useEffect(() => {
    if (view === "remove") setFoot(null);
    else if (stage === "done") {
      setFoot(
        "The codes are sealed under the vault key. Settings › Security › Recovery shows the ones left.",
      );
    } else setFoot(null);
  }, [view, stage, setFoot]);

  if (view === "remove") {
    const lastStep = listSecondSteps(header).length < 2;
    return (
      <CeremonyShell
        ok={false}
        top={`Remove the ${words.medium} code?`}
        name={masked ?? words.name}
        facts={[
          {
            key: "After",
            value: lastStep
              ? "unlock stops asking for a second step"
              : `${words.tab} is no longer offered at step 2`,
          },
          ...(lastStep
            ? [{ key: "Recovery", value: "the unused codes are discarded" }]
            : []),
          { key: "Vault", value: "untouched; your keys keep working" },
        ]}
        primary={{
          label: `Remove ${words.medium} code`,
          tone: "danger",
          busy,
          onClick: () =>
            void run(async () => {
              await store.removeCode(channel);
              onDone();
            }, `${words.name} code removed.`),
        }}
        secondary={{ label: "Keep it", onClick: onDone }}
      />
    );
  }

  const rail = (
    <Rail
      steps={["Where", "Confirm"]}
      now={stage === "where" ? 0 : stage === "confirm" ? 1 : 2}
    />
  );

  if (stage === "where") {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (!looksLikeAddress(channel, to)) return;
      void run(async () => {
        const result = await store.beginCodeEnrollment(
          channel,
          channel === "sms" ? to.replace(/[\s()-]/g, "") : to,
        );
        setSent(result);
        setSentAt(Date.now());
        setCode("");
        setStage("confirm");
      }, `A code was sent to ${to.trim()}. Enter it to turn ${words.tab.toLowerCase()} codes on.`);
    };
    return (
      <>
        {rail}
        <output className="note note--warn">
          <IconAlert size={18} />
          <span>{words.notice}</span>
        </output>
        <form onSubmit={submit} aria-label={`Send a ${words.medium} code`}>
          <CeremonyShell
            ok
            name={words.name}
            facts={[
              { key: "Sent by", value: `${identityHost()}, your Identity API` },
              {
                key: "Asked",
                value: `at unlock, when you pick ${words.tab} for step 2`,
              },
            ]}
            primary={{
              label: "Send a code",
              submit: true,
              disabled: !looksLikeAddress(channel, to),
              busy,
              onClick: () => {},
            }}
          >
            <FieldShell
              label={words.fieldLabel}
              type={channel === "email" ? "email" : "text"}
              inputMode={channel === "email" ? "email" : "tel"}
              autoComplete={channel === "email" ? "email" : "tel"}
              value={to}
              onValueChange={setTo}
              lead={words.icon}
              mono
              disabled={busy}
              fills={
                channel === "email" && accountEmail
                  ? [{ label: accountEmail, onPick: () => setTo(accountEmail) }]
                  : undefined
              }
            />
          </CeremonyShell>
        </form>
      </>
    );
  }

  if (stage === "confirm" && sent) {
    void tick;
    const coolingFor = Math.max(
      0,
      Math.ceil((sentAt + RESEND_COOLDOWN_MS - Date.now()) / 1000),
    );
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (digitsOf(code).length < 6) return;
      setRefused(false);
      void run(async () => {
        try {
          await store.confirmCodeEnrollment(code);
        } catch (error) {
          setRefused(true);
          throw error;
        }
        setCode("");
        const existing = await store.recoveryCodes();
        setCodes(existing ? null : await store.generateRecoveryCodes());
        setStage("done");
      }, `${words.name} codes are on. Every unlock now offers ${words.tab.toLowerCase()} as a second step.`);
    };
    const alts: CeremonyAlt[] = [
      {
        id: "resend",
        label:
          coolingFor > 0
            ? `Send it again · in ${coolingFor}s`
            : "Send it again",
        icon: <IconRefresh size={16} />,
        render: () => (
          <button
            type="button"
            className="btn"
            disabled={busy || coolingFor > 0}
            onClick={() =>
              void run(async () => {
                const result = await store.beginCodeEnrollment(channel, to);
                setSent(result);
                setSentAt(Date.now());
                setCode("");
                setRefused(false);
              }, `A new code was sent to ${sent.to}.`)
            }
          >
            <IconRefresh size={16} /> Send a new code
          </button>
        ),
      },
      {
        id: "change",
        label: words.change,
        icon: <IconEdit size={16} />,
        render: () => (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              store.cancelCodeEnrollment();
              setSent(null);
              setCode("");
              setRefused(false);
              setStage("where");
            }}
          >
            {words.change}
          </button>
        ),
      },
    ];
    return (
      <>
        {rail}
        <form onSubmit={submit} aria-label={`Confirm ${words.medium} code`}>
          <CeremonyShell
            ok
            top="Code sent"
            name={sent.to}
            facts={[{ key: "Good for", value: "10 minutes" }]}
            primary={{
              label: "Turn on",
              submit: true,
              disabled: digitsOf(code).length < 6,
              busy,
              onClick: () => {},
            }}
          >
            <FieldShell
              label={`Code from the ${words.medium}`}
              value={code}
              onValueChange={(next) => {
                setCode(next);
                setRefused(false);
              }}
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="000 000"
              lead={<IconSecret size={16} />}
              mono
              disabled={busy}
              status={
                refused ? (
                  <span className="chip chip--err">Did not match</span>
                ) : null
              }
            />
            {refused ? (
              <p className="hint">
                Use the newest code you were sent; an older one no longer
                counts. Five wrong codes spend it, and a new one is sent.
              </p>
            ) : null}
          </CeremonyShell>
        </form>
        <CeremonyAlts alts={alts} />
      </>
    );
  }

  const destination = sent?.to ?? to;
  return codes ? (
    <FreshCodes codes={codes} top={`${words.tab} code on`} onDone={onDone} />
  ) : (
    <CeremonyShell
      ok
      top={`${words.tab} code on`}
      name={destination}
      facts={[
        {
          key: "Asked",
          value: `at unlock, when you pick ${words.tab} for step 2`,
        },
        { key: "First choice", value: "stays the authenticator" },
      ]}
      primary={{ label: "Done", onClick: onDone }}
    />
  );
}

/** For the sheet head: the glyph a second step wears. */
export function secondStepIcon(kind: "totp" | CodeChannel): ReactNode {
  return kind === "totp" ? (
    <IconPhone size={16} />
  ) : kind === "email" ? (
    <IconMail size={16} />
  ) : (
    <IconMessage size={16} />
  );
}
