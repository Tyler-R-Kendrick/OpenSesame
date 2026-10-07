import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { decoyControlsAvailable } from "@opensesame/app-core/lib/retired-credentials/availability.js";
import { useEffect, useRef, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconEdit, IconShield } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { notifySettingsFilesChanged } from "../files/revision.js";
import { ControlledSecurityRows } from "./ControlledSecurityRow.js";
import { MethodRow } from "./MethodRow.js";
import { RetiredCredentialCeremony } from "./RetiredCredentialCeremony.js";
import { SheetFrame } from "./SheetFrame.js";
import { retiredCredentialUiPorts } from "./retired-credential-ports.js";
import type { Run } from "./run.js";

const NOTICE = "retired-credentials";
function readStatus(tomb: string) {
  try {
    return retiredCredentialUiPorts.retiredCredentialStatus(tomb);
  } catch {
    return null;
  }
}

export function useRetiredCredentialPanelShown(): boolean {
  const { tomb, guest, decoy, awaitingSecondStep, status } = useVault();
  if (guest || decoy || awaitingSecondStep || status !== "unlocked")
    return false;
  const records = readStatus(tomb);
  return decoyControlsAvailable(
    { guest, decoy: Boolean(decoy), awaitingSecondStep, status },
    retiredCredentialUiPorts.retiredCredentialEnrollmentSupported(tomb),
    records,
  );
}

function RetiredCredentialStateRow({
  status,
  busy,
  onOpen,
}: {
  status: ReturnType<typeof readStatus>;
  busy: boolean;
  onOpen: () => void;
}) {
  return (
    <MethodRow
      kind="duress"
      label="Retired passwords"
      state={
        !status
          ? "Unavailable"
          : status.events.length > 0
            ? "Observed"
            : status.traps.length
              ? "On"
              : "Off"
      }
      on={!!status && status.traps.length > 0}
      tone={!status || status.events.length > 0 ? "warn" : undefined}
      sub={
        !status
          ? "Retired password records are unavailable. Restore trusted browser data to recover."
          : status.durable
            ? "Selected old passwords: reject or open a synthetic decoy on this device."
            : "This browser is not keeping files for this site."
      }
      action={
        <IconKey
          label="Manage retired passwords"
          small
          disabled={busy || !status}
          onClick={onOpen}
        >
          <IconEdit size={16} />
        </IconKey>
      }
    />
  );
}

export function RetiredCredentialRow() {
  const { tomb } = useVault();
  const shown = useRetiredCredentialPanelShown();
  const supported =
    retiredCredentialUiPorts.retiredCredentialEnrollmentSupported(tomb);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [status, setStatus] = useState(() => readStatus(tomb));
  const currentScope = useRef({ tomb, shown, version: 0 });
  if (
    currentScope.current.tomb !== tomb ||
    currentScope.current.shown !== shown
  ) {
    currentScope.current = {
      tomb,
      shown,
      version: currentScope.current.version + 1,
    };
  }
  const refresh = async (): Promise<boolean> => {
    const version = currentScope.current.version;
    const next = await retiredCredentialUiPorts.refreshStatus(tomb);
    const scope = currentScope.current;
    if (!scope.shown || scope.tomb !== tomb || scope.version !== version)
      return false;
    setStatus(next);
    notifySettingsFilesChanged();
    return true;
  };
  useEffect(() => {
    setOpen(false);
    if (shown) setStatus(readStatus(tomb));
  }, [tomb, shown]);
  const run: Run = async (action, message) => {
    dismissNotice(NOTICE);
    setSaid("");
    setBusy(true);
    try {
      await action();
      if (message) setSaid(message);
    } catch (error) {
      setStatusNotice({
        id: NOTICE,
        tone: "err",
        title: "Retired passwords",
        body:
          error instanceof Error
            ? error.message
            : "The change could not be saved.",
      });
    } finally {
      setBusy(false);
    }
  };
  if (!shown) return null;
  return (
    <section className="panel set__security" id="decoy">
      <div className="panel__head">
        <div>
          <h2>Decoy</h2>
        </div>
      </div>
      <div className="panel__body">
        <output className="visually-hidden" aria-live="polite">
          {said}
        </output>
        <ControlledSecurityRows />
        <RetiredCredentialStateRow
          status={status}
          busy={busy}
          onOpen={() =>
            void run(async () => {
              if (await refresh()) setOpen(true);
            }, null)
          }
        />
      </div>
      {open && status ? (
        <SheetFrame
          title="Retired passwords"
          mark={<IconShield size={20} />}
          busy={busy}
          onClose={() => setOpen(false)}
        >
          <RetiredCredentialCeremony
            tomb={tomb}
            supported={supported}
            status={status}
            busy={busy}
            run={run}
            refresh={refresh}
          />
        </SheetFrame>
      ) : null}
    </section>
  );
}
