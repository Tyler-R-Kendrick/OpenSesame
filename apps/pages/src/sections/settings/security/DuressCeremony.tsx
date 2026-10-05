import {
  DURESS_CODE_DIGITS,
  type DuressRefusal,
  enableDuressCode,
  isAcceptableDuressCode,
  removeDuressCode,
} from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import {
  type DuressMode,
  type DuressModeId,
  MODES,
} from "@opensesame/app-core/lib/duress/settings/modes/index.js";
import {
  type CeremonyAlt,
  CeremonyAlts,
  CeremonyShell,
} from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconShield, IconTrash } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import type { Run } from "./run.js";
import { useDuressCeremony } from "./useDuressCeremony.js";
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
      secondary={{
        label: "Keep it",
        disabled: busy,
        onClick: () => onDone(""),
      }}
    />
  );
}

function ModePick({
  mode,
  busy,
  onPick,
}: {
  mode: DuressModeId;
  busy: boolean;
  onPick: (next: DuressModeId) => void;
}) {
  return (
    <fieldset className="duress__pick" disabled={busy}>
      <legend className="duress__legend">Entering it shows</legend>
      <ul className="duress__choices">
        {MODES.map((item) => (
          <li key={item.id}>
            <label className="duress__choice">
              <input
                type="radio"
                name="duress-mode"
                value={item.id}
                checked={mode === item.id}
                onChange={() => onPick(item.id)}
              />
              <span>{item.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** The extra input a mode declares, below the radios; none does yet. */
function ModeInput({
  mode,
  busy,
  value,
  onValue,
}: {
  mode: DuressMode;
  busy: boolean;
  value: string;
  onValue: (next: string) => void;
}) {
  const { input } = mode;
  if (input.kind === "none") return null;
  return (
    <FieldShell
      label={input.label}
      value={value}
      onValueChange={onValue}
      autoComplete="off"
      disabled={busy}
    />
  );
}

function CodeFields({
  busy,
  mode,
  first,
  second,
  understood,
  refusal,
  onFirst,
  onSecond,
  onUnderstood,
}: {
  busy: boolean;
  mode: DuressMode;
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
        <span>{mode.consent}</span>
      </label>
    </>
  );
}

function removeAlts(
  armed: boolean,
  busy: boolean,
  run: Run,
  onDone: (message: string) => void,
): CeremonyAlt[] {
  if (!armed) return [];
  return [
    {
      id: "remove",
      label: "Remove the duress code",
      icon: <IconTrash size={16} />,
      render: () => <RemoveCard busy={busy} run={run} onDone={onDone} />,
    },
  ];
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
  const form = useDuressCeremony({ armed, busy, run, onDone, arm });
  const alts = removeAlts(armed, busy, run, onDone);

  return (
    <>
      <form onSubmit={form.submit} aria-label="Duress code form">
        <CeremonyShell
          ok
          top={armed ? "On" : undefined}
          name="Duress code · this device"
          facts={[
            { key: "Opens", value: form.mode.opens },
            { key: "Asked", value: "where you unlock, as the whole code" },
            { key: "Vault", value: "stays sealed; this code never opens it" },
          ]}
          primary={{
            label: armed ? "Change duress code" : "Turn on duress code",
            submit: true,
            disabled: !form.ready,
            busy,
            onClick: () => {},
          }}
        >
          <ModePick mode={form.modeId} busy={busy} onPick={form.pick} />
          <ModeInput
            mode={form.mode}
            busy={busy}
            value={form.extra}
            onValue={form.setExtra}
          />
          <CodeFields
            busy={busy}
            mode={form.mode}
            first={form.first}
            second={form.second}
            understood={form.understood}
            refusal={form.refusal}
            onFirst={form.typeFirst}
            onSecond={form.typeSecond}
            onUnderstood={form.understand}
          />
        </CeremonyShell>
      </form>
      <CeremonyAlts alts={alts} />
    </>
  );
}
