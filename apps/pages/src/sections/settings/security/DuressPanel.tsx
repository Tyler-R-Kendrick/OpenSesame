import {
  DURESS_CODE_DIGITS,
  type DuressStatus,
  clearDuressIncidents,
  duressStatus,
  type enableDuressCode,
} from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { useEffect, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconCheck,
  IconEdit,
  IconPlus,
  IconShield,
} from "../../../components/Icons.js";
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

const NOTICE_ID = "duress-code";

/**
 * One action at a time, the way the key sheets run: a success is announced
 * (the row's own state shows it), a failure is a notice in the tray rather
 * than a box in the page behind the sheet (DESIGN.md).
 */
function useDuressRun() {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const run: Run = async (action, ok) => {
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
        title: "Duress code",
        body: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
    }
  };
  return { busy, said, setSaid, run };
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
  const { busy, said, setSaid, run } = useDuressRun();

  // Locking takes the row away; it must take the sheet with it, or the next
  // unlock opens a ceremony nobody asked for.
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  if (!shown) return null;

  return (
    <section className="panel set__security" id="duress-profiles">
      <div className="panel__head">
        <div>
          <h2>Duress</h2>
        </div>
      </div>
      <div className="panel__body">
        <output className="visually-hidden" aria-live="polite">
          {said}
        </output>
        <DuressRow
          status={status}
          busy={busy}
          onClear={() =>
            void run(async () => {
              const result = await clearDuressIncidents();
              if (!result.ok) {
                throw new Error("It could not be cleared. Try again.");
              }
              setStatus(result.status);
            }, "Cleared. The code is still on.")
          }
          onOpen={() => {
            dismissNotice(NOTICE_ID);
            setSaid("");
            setOpen(true);
          }}
        />
      </div>
      {open ? (
        <SheetFrame
          title="Duress code"
          mark={<IconShield size={20} />}
          busy={busy}
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
              if (text) setSaid(text);
            }}
          />
        </SheetFrame>
      ) : null}
    </section>
  );
}
