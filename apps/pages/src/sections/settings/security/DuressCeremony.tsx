import {
  DURESS_CODE_DIGITS,
  type DuressOutcome,
  type DuressRefusal,
  enableDuressCode,
  isAcceptableDuressCode,
  removeDuressCode,
} from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import { activeProject } from "@opensesame/app-core/lib/projects.js";
import { type FormEvent, useState } from "react";
import {
  type CeremonyAlt,
  CeremonyAlts,
  CeremonyShell,
} from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconShield, IconTrash } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import type { Run } from "./run.js";
import "./duress-sheet.css";

/** What a refusal means, in the sheet's words. */
const REFUSAL = new Map<DuressRefusal, string>([
  ["code_format", `A duress code is ${DURESS_CODE_DIGITS}.`],
  [
    "collides",
    "That code opens a vault on this device. Pick one you never use to unlock.",
  ],
  ["not_durable", "This browser is not keeping files for this site."],
  ["incident_active", "A duress response holds this device."],
  ["failed", "The code could not be set."],
]);

export function duressRefusalText(code: DuressRefusal): string {
  return REFUSAL.get(code) ?? "The code could not be set.";
}

const OUTCOMES = [
  { id: "decoy", label: "Decoy vault" },
  { id: "refuse", label: "Wrong password" },
] as const satisfies readonly { id: DuressOutcome; label: string }[];

const OPENS = {
  decoy: "an empty decoy vault, like a normal unlock",
  refuse: "nothing; it reads as a wrong password",
} satisfies Record<DuressOutcome, string>;

const CONSENT = {
  decoy: "I understand this code opens a decoy, never my vault.",
  refuse: "I understand this code is refused like a wrong password.",
} satisfies Record<DuressOutcome, string>;

function RemoveCard({
  busy,
  run,
  onDone,
}: {
  busy: boolean;
  run: Run;
  onDone: (message: string) => void;
}) {
  return (
    <CeremonyShell
      ok={false}
      top="Remove the duress code?"
      name="Duress code · this device"
      facts={[
        { key: "After", value: "unlock is ordinary; the code is just a guess" },
        { key: "Vault", value: "untouched; nothing inside changes" },
      ]}
      primary={{
        label: "Remove duress code",
        tone: "danger",
        busy,
        onClick: () =>
          void run(async () => {
            const result = await removeDuressCode();
            if (!result.ok) throw new Error(duressRefusalText(result.code));
            onDone("Duress code removed.");
          }, null),
      }}
      secondary={{ label: "Keep it", onClick: () => onDone("") }}
    />
  );
}

function OutcomePick({
  outcome,
  busy,
  onPick,
}: {
  outcome: DuressOutcome;
  busy: boolean;
  onPick: (next: DuressOutcome) => void;
}) {
  return (
    <div className="duress__pick">
      <span className="duress__legend" id="duress-does">
        Entering it shows
      </span>
      <div
        className="set__view"
        role="radiogroup"
        aria-labelledby="duress-does"
      >
        {OUTCOMES.map((item) => (
          <button
            key={item.id}
            type="button"
            className="set__view-btn"
            aria-pressed={outcome === item.id}
            disabled={busy}
            onClick={() => onPick(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CodeFields({
  busy,
  outcome,
  first,
  second,
  understood,
  refusal,
  onFirst,
  onSecond,
  onUnderstood,
}: {
  busy: boolean;
  outcome: DuressOutcome;
  first: string;
  second: string;
  understood: boolean;
  refusal: DuressRefusal | null;
  onFirst: (next: string) => void;
  onSecond: (next: string) => void;
  onUnderstood: (next: boolean) => void;
}) {
  const acceptable = isAcceptableDuressCode(first);
  const matches = second.length > 0 && first === second;
  return (
    <>
      <FieldShell
        label="Duress code"
        type="password"
        inputMode="numeric"
        value={first}
        onValueChange={onFirst}
        autoComplete="off"
        lead={<IconShield size={16} />}
        mono
        disabled={busy}
        status={
          (first.length > 0 && !acceptable) || refusal ? (
            <StatusMark
              tone="err"
              label={
                refusal
                  ? duressRefusalText(refusal)
                  : `${DURESS_CODE_DIGITS}, digits only`
              }
            />
          ) : null
        }
        hint={refusal ? duressRefusalText(refusal) : undefined}
      />
      <FieldShell
        label="Confirm duress code"
        type="password"
        inputMode="numeric"
        value={second}
        onValueChange={onSecond}
        autoComplete="off"
        lead={<IconShield size={16} />}
        mono
        disabled={busy}
        status={
          second.length > 0 ? (
            <StatusMark
              tone={matches ? "ok" : "err"}
              label={matches ? "Matches" : "Does not match"}
            />
          ) : null
        }
      />
      <label className="duress__ack">
        <input
          type="checkbox"
          checked={understood}
          disabled={busy}
          onChange={(event) => onUnderstood(event.target.checked)}
        />
        <span>{CONSENT[outcome]}</span>
      </label>
    </>
  );
}

/**
 * Set or change this device's duress code: pick what it does, type it twice,
 * say you understand. Arming seals the code, proves the sealed slot opens
 * with it, and refuses a code that also opens a vault here — so the person
 * finds out now, not at the worst moment. Removal is the alternative below
 * the card, the road the key ceremonies use.
 */
export function DuressCeremony({
  armed,
  busy,
  run,
  onDone,
  arm = enableDuressCode,
}: {
  /** What seals and arms the code; a test that cannot keep files swaps it. */
  arm?: typeof enableDuressCode;
  armed: boolean;
  busy: boolean;
  run: Run;
  /** Closes the sheet; `message` is what the panel says, or nothing. */
  onDone: (message: string) => void;
}) {
  const [outcome, setOutcome] = useState<DuressOutcome>("decoy");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [refusal, setRefusal] = useState<DuressRefusal | null>(null);
  const ready = isAcceptableDuressCode(first) && first === second && understood;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setRefusal(null);
    void run(async () => {
      const result = await arm({
        code: first,
        outcome,
        vaultRef: activeProject().id,
      });
      if (!result.ok) {
        // Kept, so the person can fix it; the reason shows in the card.
        setRefusal(result.code);
        return;
      }
      setFirst("");
      setSecond("");
      onDone(armed ? "Duress code changed." : "Duress code is on.");
    }, null);
  }

  const alts: CeremonyAlt[] = armed
    ? [
        {
          id: "remove",
          label: "Remove the duress code",
          icon: <IconTrash size={16} />,
          render: () => <RemoveCard busy={busy} run={run} onDone={onDone} />,
        },
      ]
    : [];

  return (
    <>
      <form onSubmit={submit} aria-label="Duress code form">
        <CeremonyShell
          ok
          top={armed ? "On" : undefined}
          name="Duress code · this device"
          facts={[
            { key: "Opens", value: OPENS[outcome] },
            { key: "Asked", value: "where you unlock, as the whole code" },
            { key: "Vault", value: "stays sealed; this code never opens it" },
          ]}
          primary={{
            label: armed ? "Change duress code" : "Turn on duress code",
            submit: true,
            disabled: !ready,
            busy,
            onClick: () => {},
          }}
        >
          <OutcomePick outcome={outcome} busy={busy} onPick={setOutcome} />
          <CodeFields
            busy={busy}
            outcome={outcome}
            first={first}
            second={second}
            understood={understood}
            refusal={refusal}
            onFirst={(next) => {
              setFirst(next.trim());
              setRefusal(null);
            }}
            onSecond={(next) => setSecond(next.trim())}
            onUnderstood={setUnderstood}
          />
        </CeremonyShell>
      </form>
      <CeremonyAlts alts={alts} />
    </>
  );
}
