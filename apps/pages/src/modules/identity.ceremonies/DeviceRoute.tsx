/**
 * `/device` (ADR 0140 plan step 7): approve a device or CLI sign-in from the
 * link it printed. The code arrives as `?user_code=` — or in one of the
 * older shapes `bootCore` normalised to it — and left the address before the
 * first paint (`app-core/lib/device-link.ts`); this screen takes it from
 * there and asks the person to confirm it against the device.
 *
 * The approval itself is Identity › Devices' form (`DeviceApproval`), not a
 * second copy. It needs a signed-in Identity session, never a vault (ADR 0140
 * §2): the route opens before unlock, on a locked or empty device too, and
 * without a session — or with no Identity API configured — it shows the
 * Connect note every Identity-plane panel does. Where the shell's tray is
 * not mounted, a refusal is the mark beside the code.
 */

import {
  DEVICE_LINK_REFUSED,
  type DeviceApprovalResult,
  reportRefusedDeviceLink,
} from "@opensesame/app-core/lib/device-approval.js";
import {
  captureDeviceLinkFromPage,
  peekDeviceArrival,
  takeDeviceArrival,
} from "@opensesame/app-core/lib/device-link.js";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useIdentitySession } from "../../bindings/identity.js";
import { firstControl, landFocus } from "../../lib/focus.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useOnline } from "../../lib/use-online.js";
import { ConnectIdentityNote } from "../../sections/identity/ConnectIdentityNote.js";
import { DeviceApproval } from "../../sections/identity/DeviceApproval.js";

const REFUSED: DeviceApprovalResult = {
  tone: "err",
  words: DEVICE_LINK_REFUSED,
};

export function DeviceRoute() {
  const online = useOnline();
  const configured = useIdentityConfigured();
  const session = useIdentitySession();
  const location = useLocation();
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement | null>(null);
  const ready = configured && session !== null;
  // An in-app navigation to `/device?user_code=…` never passed through boot:
  // read it here, the same way. The code stays waiting in the core until it
  // is approved, so the route coming back — connecting a session re-resolves
  // the plan and remounts it — still shows it; a refusal is said once.
  const [arrival] = useState(() => {
    captureDeviceLinkFromPage();
    return peekDeviceArrival();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    if (arrival.kind === "refused") {
      takeDeviceArrival();
      reportRefusedDeviceLink();
    }
    if (location.search || location.hash) {
      navigate(location.pathname, { replace: true });
    }
  }, []);

  // Without a session the useful first key is the one that gets one — the
  // address of a sign-in service, or Connect. With one, the form places it.
  useEffect(() => {
    if (!ready) landFocus(firstControl(root.current));
  }, [ready]);

  const arrivedCode = arrival.kind === "code" ? arrival.userCode : null;
  return (
    <div className="section__inner" ref={root}>
      <div className="section__head">
        <h1>Approve a device</h1>
      </div>
      {ready ? (
        <section className="panel" aria-label="Device sign-in">
          <div className="panel__body">
            <DeviceApproval
              online={online}
              arrivedCode={arrivedCode}
              initialResult={arrival.kind === "refused" ? REFUSED : null}
            />
          </div>
        </section>
      ) : (
        <ConnectIdentityNote online={online} what="the devices that sign in" />
      )}
    </div>
  );
}
