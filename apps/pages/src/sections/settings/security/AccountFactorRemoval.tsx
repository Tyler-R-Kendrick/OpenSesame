import {
  AccountFactorError,
  type AccountFactorKind,
  type AccountFactorStepUp,
  hostAccountPasskeyAuthenticator,
  removeAccountFactor,
} from "@opensesame/app-core/lib/account-factors.js";
import { digitsOf } from "@opensesame/app-core/sections/settings/security/second-step-ceremonies-model.js";
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconPasskey, IconPhone } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { landFocus } from "../../../lib/focus.js";
import type { Run } from "./run.js";

/**
 * Removing one of the account's factors, in the one Security sheet (ADR
 * 0146, ADR 0091 §8). The sign-in service strips nothing on the strength of
 * the session alone, so the card asks for a fresh proof from one of the
 * account's own factors — the one being removed counts — before it sends
 * the delete. Where the account has both kinds the person picks which to
 * prove with; the pick is a choice object, the act is the one danger key.
 *
 * Both outcomes are a mark in the card's live region, never a box. A
 * refused proof leaves the person signed in (the service answers 403, not
 * 401) and the keyboard where the next try starts: the cleared code field,
 * or the key. A removal lands on Done.
 */

export type RemovalFactor = {
  id: string;
  name: string;
  /** Which of the account's factor kinds can prove this removal. */
  proofs?: AccountFactorKind[];
};

const PROOF_LABEL = {
  passkey: "Passkey",
  totp: "Authenticator code",
} satisfies Record<AccountFactorKind, string>;

const PROOF_FACT = {
  passkey: "a passkey on your account",
  totp: "the code your authenticator shows now",
} satisfies Record<AccountFactorKind, string>;

/** The kinds this browser can prove with, passkey first when it can. */
function usable(proofs: AccountFactorKind[] | undefined): AccountFactorKind[] {
  return (proofs ?? []).filter(
    (kind) => kind !== "passkey" || hostAccountPasskeyAuthenticator.available(),
  );
}

type Landing = { at: string; n: number };

/**
 * Once the run settles and a frame has passed — so the sheet's own landing
 * on Close goes first — put the keyboard on `landing.at`, once.
 */
function useLanding(
  root: RefObject<HTMLElement | null>,
  busy: boolean,
  landing: Landing | null,
  done: () => void,
) {
  useEffect(() => {
    if (busy || landing === null) return;
    const frame = requestAnimationFrame(() => {
      if (landFocus(root.current?.querySelector(landing.at))) done();
    });
    return () => cancelAnimationFrame(frame);
  }, [root, busy, landing, done]);
}

/**
 * Send the removal with its proof. The outcome is told by the card, so the
 * run carries no sentence of its own, and a refusal never reaches the
 * panel's note: it is the card's mark.
 */
function attemptRemoval(
  run: Run,
  id: string,
  stepUp: AccountFactorStepUp,
  outcome: { refused: (message: string) => void; removed: () => void },
): Promise<void> {
  return run(async () => {
    try {
      await removeAccountFactor(id, stepUp);
    } catch (error) {
      outcome.refused(
        error instanceof AccountFactorError
          ? error.message
          : "That did not work. Nothing changed.",
      );
      return;
    }
    outcome.removed();
  }, null);
}

export function AccountFactorRemoval({
  passkey,
  factor,
  busy,
  run,
  onDone,
}: {
  /** Whether the factor being removed is a passkey (else the authenticator). */
  passkey: boolean;
  factor: RemovalFactor;
  busy: boolean;
  run: Run;
  onDone: () => void;
}) {
  const offered = usable(factor.proofs);
  const [by, setBy] = useState<AccountFactorKind | null>(offered[0] ?? null);
  const [code, setCode] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  // Where the keyboard goes next, with a counter so a second refusal lands
  // again: the field, the danger key, or Done.
  const [landing, setLanding] = useState<Landing | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const landed = useCallback(() => setLanding(null), []);
  useLanding(root, busy, landing, landed);
  const land = (at: string) =>
    setLanding((last) => ({ at, n: (last?.n ?? 0) + 1 }));

  const top = passkey ? "Remove this passkey?" : "Remove the authenticator?";
  const title = passkey ? "Account passkey" : "Account authenticator app";

  if (removed) {
    return (
      <div ref={root}>
        <RemovedCard name={factor.name} title={title} onDone={onDone} />
      </div>
    );
  }

  if (by === null) {
    return (
      <CeremonyShell
        ok={false}
        top={top}
        name="This browser cannot use a passkey"
        facts={[{ key: "Use", value: "a browser with passkeys" }]}
        secondary={{ label: "Keep it", onClick: onDone }}
      />
    );
  }

  const ready =
    by === "passkey" || (by === "totp" && digitsOf(code).length === 6);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setRefusal(null);
    const stepUp: AccountFactorStepUp =
      by === "totp" ? { kind: "totp", code } : { kind: "passkey" };
    void attemptRemoval(run, factor.id, stepUp, {
      refused: (message) => {
        setRefusal(message);
        setCode("");
        land(by === "totp" ? "input" : ".btn--danger");
      },
      removed: () => {
        setRemoved(true);
        land(".btn--primary");
      },
    });
  };

  return (
    <div ref={root}>
      <ProveForm
        passkey={passkey}
        name={factor.name}
        top={top}
        by={by}
        offered={offered}
        code={code}
        refusal={refusal}
        busy={busy}
        ready={ready}
        onSubmit={submit}
        onPick={(kind) => {
          setBy(kind);
          setRefusal(null);
          if (kind === "totp") land("input");
        }}
        onCode={(next) => {
          setCode(next);
          setRefusal(null);
        }}
        onDone={onDone}
      />
    </div>
  );
}

/** The removal card: what changes, which proof, the one danger key. */
function ProveForm({
  passkey,
  name,
  top,
  by,
  offered,
  code,
  refusal,
  busy,
  ready,
  onSubmit,
  onPick,
  onCode,
  onDone,
}: {
  passkey: boolean;
  name: string;
  top: string;
  by: AccountFactorKind;
  offered: AccountFactorKind[];
  code: string;
  refusal: string | null;
  busy: boolean;
  ready: boolean;
  onSubmit: (event: FormEvent) => void;
  onPick: (kind: AccountFactorKind) => void;
  onCode: (next: string) => void;
  onDone: () => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      aria-label={
        passkey ? "Remove account passkey" : "Remove account authenticator"
      }
    >
      <CeremonyShell
        ok={false}
        top={top}
        name={name}
        facts={[
          {
            key: "After",
            value: passkey
              ? "your sign-in service stops accepting it"
              : "your sign-in service stops asking for its codes",
          },
          { key: "Vault", value: "untouched; its keys keep working" },
          { key: "Proof", value: PROOF_FACT[by] },
        ]}
        primary={{
          label: passkey ? "Remove passkey" : "Remove authenticator",
          tone: "danger",
          submit: true,
          disabled: !ready,
          busy,
          onClick: () => {},
        }}
        secondary={{ label: "Keep it", onClick: onDone }}
      >
        {offered.length > 1 ? (
          <ProofChoice offered={offered} by={by} busy={busy} onPick={onPick} />
        ) : null}
        {by === "totp" ? (
          <FieldShell
            label="Six digits"
            value={code}
            onValueChange={onCode}
            autoComplete="one-time-code"
            inputMode="numeric"
            placeholder="000 000"
            lead={<IconPhone size={16} />}
            mono
            disabled={busy}
          />
        ) : null}
        <output aria-live="polite">
          {refusal ? <StatusMark tone="err" label={refusal} /> : null}
        </output>
      </CeremonyShell>
    </form>
  );
}

/** Which of the account's factors proves the removal: a choice object. */
function ProofChoice({
  offered,
  by,
  busy,
  onPick,
}: {
  offered: AccountFactorKind[];
  by: AccountFactorKind;
  busy: boolean;
  onPick: (kind: AccountFactorKind) => void;
}) {
  return (
    <fieldset className="picker" aria-label="Prove it is you with">
      {offered.map((kind) => (
        <button
          key={kind}
          type="button"
          className={`picker__opt${kind === by ? " is-on" : ""}`}
          aria-pressed={kind === by}
          disabled={busy}
          onClick={() => onPick(kind)}
        >
          {kind === "passkey" ? (
            <IconPasskey size={16} />
          ) : (
            <IconPhone size={16} />
          )}
          <span>{PROOF_LABEL[kind]}</span>
        </button>
      ))}
    </fieldset>
  );
}

/** The factor is gone: an ok mark in the live region, and Done. */
function RemovedCard({
  name,
  title,
  onDone,
}: {
  name: string;
  title: string;
  onDone: () => void;
}) {
  return (
    <CeremonyShell
      ok
      top="Removed"
      name={name}
      facts={[{ key: "Vault", value: "untouched; its keys keep working" }]}
      primary={{ label: "Done", onClick: onDone }}
    >
      <output aria-live="polite">
        <StatusMark tone="ok" label={`${title} removed.`} />
      </output>
    </CeremonyShell>
  );
}
