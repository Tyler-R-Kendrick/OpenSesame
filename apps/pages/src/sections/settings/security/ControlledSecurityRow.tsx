import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconEdit, IconShield } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import { LegacyConnectorRow } from "./LegacyConnectorRow.js";
import { MethodRow } from "./MethodRow.js";
import { SheetFrame } from "./SheetFrame.js";
import { retiredCredentialUiPorts } from "./retired-credential-ports.js";
const CanaryCeremony = lazy(() => import("./CanaryCeremony.js"));
const ReceiverCeremony = lazy(() => import("./ReceiverCeremony.js"));
export function ControlledSecurityRows() {
  const canaryRef = useGuideTarget<HTMLDivElement>(
    "settings.security.canaries",
  );
  const receiverRef = useGuideTarget<HTMLDivElement>(
    "settings.security.receiver",
  );
  const { tomb, guest, decoy, awaitingSecondStep, status } = useVault();
  const [open, setOpen] = useState<"canary" | "receiver" | null>(null);
  const shown =
    status === "unlocked" && !guest && !decoy && !awaitingSecondStep;
  const scope = useRef(tomb);
  useEffect(() => {
    if (!shown || scope.current !== tomb) setOpen(null);
    scope.current = tomb;
  }, [tomb, shown]);
  if (!shown) return null;
  const supported =
    retiredCredentialUiPorts.retiredCredentialEnrollmentSupported(tomb);
  return (
    <>
      <LegacyConnectorRow />
      <div ref={canaryRef}>
        <MethodRow
          kind="duress"
          label="Controlled canaries"
          state="Local"
          on={false}
          sub="Instrumented references and a synthetic MCP validator."
          action={
            <IconKey
              label="Manage controlled canaries"
              small
              onClick={() => setOpen("canary")}
            >
              <IconEdit size={16} />
            </IconKey>
          }
        />
      </div>
      <div ref={receiverRef}>
        <MethodRow
          kind="duress"
          label="Observation receiver"
          state="Optional"
          on={false}
          sub="An independently supplied receiver for sealed evidence."
          action={
            <IconKey
              label="Manage observation receiver"
              small
              onClick={() => setOpen("receiver")}
            >
              <IconEdit size={16} />
            </IconKey>
          }
        />
      </div>
      {open ? (
        <SheetFrame
          title={
            open === "canary" ? "Controlled canaries" : "Observation receiver"
          }
          mark={<IconShield size={20} />}
          busy={false}
          onClose={() => setOpen(null)}
        >
          <Suspense fallback={<output>Loading local records…</output>}>
            {open === "canary" ? (
              <CanaryCeremony tomb={tomb} supported={supported} />
            ) : (
              <ReceiverCeremony tomb={tomb} supported={supported} />
            )}
          </Suspense>
        </SheetFrame>
      ) : null}
    </>
  );
}
