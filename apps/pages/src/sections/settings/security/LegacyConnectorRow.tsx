import { Suspense, lazy, useEffect, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconEdit, IconShield } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { MethodRow } from "./MethodRow.js";
import { SheetFrame } from "./SheetFrame.js";
import { pinSecurityOwner } from "./security-owner.js";
const LegacyConnectorCeremony = lazy(
  () => import("./LegacyConnectorCeremony.js"),
);
export function LegacyConnectorRow() {
  const { tomb, status, guest, decoy, awaitingSecondStep } = useVault();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const shown =
    status === "unlocked" && !guest && !decoy && !awaitingSecondStep;
  useEffect(() => {
    let alive = true;
    setOpen(false);
    setPending(false);
    if (!shown) return;
    let check: () => void;
    try {
      check = pinSecurityOwner(tomb);
    } catch {
      return;
    }
    void import("@opensesame/app-core/lib/device-connector-legacy.js")
      .then(async (api) => {
        check();
        const status = await api.refreshLegacyDeviceConnectorStatus(tomb);
        check();
        if (alive) setPending(status.pending);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tomb, shown]);
  if (!shown || !pending) return null;
  return (
    <>
      <MethodRow
        kind="duress"
        label="Legacy connector records"
        state="Pending"
        on={false}
        sub="Choose where old device-protected records belong before enrolling a retired password."
        action={
          <IconKey
            label="Review legacy connector records"
            small
            onClick={() => setOpen(true)}
          >
            <IconEdit size={16} />
          </IconKey>
        }
      />
      {open ? (
        <SheetFrame
          title="Legacy connector records"
          mark={<IconShield size={20} />}
          busy={false}
          onClose={() => setOpen(false)}
        >
          <Suspense fallback={<output>Loading legacy metadata…</output>}>
            <LegacyConnectorCeremony
              tomb={tomb}
              onResolved={() => {
                setPending(false);
                setOpen(false);
              }}
            />
          </Suspense>
        </SheetFrame>
      ) : null}
    </>
  );
}
