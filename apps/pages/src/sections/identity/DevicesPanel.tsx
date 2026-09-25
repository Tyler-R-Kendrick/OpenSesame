import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { ConnectIdentityNote } from "./ConnectIdentityNote.js";
import { DeviceApproval } from "./DeviceApproval.js";

type DevicesProps = { online: boolean; session: IdentitySession | null };

/** The directory's part of the Devices tab: approving a device that signs in. */
export function DirectoryDevices({ online, session }: DevicesProps) {
  const configured = useIdentityConfigured();
  return (
    <>
      {configured && session ? <ApproveDeviceCard online={online} /> : null}
      {configured && !session ? (
        <ConnectIdentityNote
          online={online}
          what="Approving the devices that sign in"
        />
      ) : null}
    </>
  );
}

/** The same form the `/device` route draws (`DeviceApproval`), in a panel. */
function ApproveDeviceCard({ online }: { online: boolean }) {
  return (
    <section className="panel" aria-labelledby="identity-device-approve">
      <div className="panel__head">
        <div>
          <h2 id="identity-device-approve">Approve a device</h2>
        </div>
      </div>
      <div className="panel__body">
        <DeviceApproval online={online} id="identity-device-code" />
      </div>
    </section>
  );
}
