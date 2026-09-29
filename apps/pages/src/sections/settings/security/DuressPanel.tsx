import {
  DURESS_CODE_DIGITS,
  type DuressStatus,
  clearDuressIncidents,
  duressStatus,
  type enableDuressCode,
} from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import { useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconCheck,
  IconEdit,
  IconPlus,
  IconShield,
} from "../../../components/Icons.js";
import { StatusNote } from "../../../components/StatusNote.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { DuressCeremony } from "./DuressCeremony.js";
import { MethodRow } from "./MethodRow.js";
import { SheetFrame } from "./SheetFrame.js";
import type { Run } from "./run.js";

/** Whether the Duress row draws: the owner of an open vault, never a guest. */
export function useDuressPanelShown(): boolean {
  const { guest, status } = useVault();
  return !guest && status === "unlocked";
}

type Message = { tone: "ok" | "err"; text: string } | null;

/** One action at a time, with what it said, the way the key sheets run. */
function useDuressRun() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const run: Run = async (action, ok) => {
    setMessage(null);
    setBusy(true);
    try {
      await action();
      if (ok !== null) setMessage({ tone: "ok", text: ok });
    } catch (caught) {
      setMessage({
        tone: "err",
        text: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, setMessage, run };
}

function DuressRow({
  status,
  busy,
  onClear,
  onOpen,
}: {
  status: DuressStatus;
  busy: boolean;
  onClear: () => void;
  onOpen: () => void;
}) {
  const { armed, incidents } = status;
  return (
    <MethodRow
      kind="duress"
      label="Duress code"
      state={incidents > 0 ? "Used" : armed ? "On" : "Off"}
      on={armed && incidents === 0}
      tone={incidents > 0 ? "warn" : undefined}
      sub={
        incidents > 0
          ? "The code was used here. This device holds you to a guest's powers until you clear it."
          : armed
            ? "Set on this device. What it does is sealed with it."
            : `${DURESS_CODE_DIGITS}. Not one you unlock with.`
      }
      action={
        incidents > 0 ? (
          <IconKey label="Clear" small disabled={busy} onClick={onClear}>
            <IconCheck size={16} />
          </IconKey>
        ) : (
          <IconKey
            label={armed ? "Change" : "Add"}
            small
            disabled={busy}
            onClick={onOpen}
          >
            {armed ? <IconEdit size={16} /> : <IconPlus size={16} />}
          </IconKey>
        )
      }
    />
  );
}

/**
 * Settings › Security › Duress: one row of read-only state and one key, the
 * way every unlock method is drawn, with the ceremony in the sheet the key
 * opens. Drawn only to the owner of an open vault. A guest session — which
 * is what a decoy is — gets no row at all, so a person made to open Settings
 * in front of someone finds nothing to disable and nothing that says it is
 * there (ADR 0130, INV-27).
 */
export function DuressPanel({
  arm,
}: {
  arm?: typeof enableDuressCode;
}) {
  const shown = useDuressPanelShown();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(duressStatus);
  const { armed } = status;
  const refresh = () => setStatus(duressStatus());
  const { busy, message, setMessage, run } = useDuressRun();

  if (!shown) return null;

  return (
    <section className="panel set__security" id="duress-profiles">
      <div className="panel__head">
        <div>
          <h2>Duress</h2>
          <p className="hint">
            A second code that opens something else, in front of someone who
            makes you unlock.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <StatusNote message={message} />
        <DuressRow
          status={status}
          busy={busy}
          onClear={() => {
            setStatus(clearDuressIncidents());
            setMessage({ tone: "ok", text: "Cleared. The code is still on." });
          }}
          onOpen={() => {
            setMessage(null);
            setOpen(true);
          }}
        />
      </div>
      {open ? (
        <SheetFrame
          title="Duress code"
          subtitle="A second code. Typed where you unlock, it opens something else."
          mark={<IconShield size={20} />}
          foot="Nothing changes until you press the button in the card. Your vault is never opened by this code."
          onClose={() => {
            setOpen(false);
            refresh();
          }}
        >
          <DuressCeremony
            arm={arm}
            armed={armed}
            busy={busy}
            run={run}
            onDone={(text) => {
              setOpen(false);
              refresh();
              if (text) setMessage({ tone: "ok", text });
            }}
          />
        </SheetFrame>
      ) : null}
    </section>
  );
}
