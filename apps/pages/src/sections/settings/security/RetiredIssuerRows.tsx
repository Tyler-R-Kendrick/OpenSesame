import { useEffect, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconBell } from "../../../components/Icons.js";
import { CeremonyRow } from "../CeremonyRow.js";
import { pinSecurityOwner } from "./security-owner.js";
type Issued = { issuerRecordRef: string; context: { generation: number } };
export function RetiredIssuerRows(props: {
  tomb: string;
  disabled: boolean;
  retire: (issuerRecordRef: string) => Promise<void>;
}) {
  const [issued, setIssued] = useState<Issued[]>([]);
  useEffect(() => {
    let alive = true;
    let check: () => void;
    try {
      check = pinSecurityOwner(props.tomb);
    } catch {
      return;
    }
    void import("@opensesame/app-core/lib/capabilities/lease-canary-issuer.js")
      .then((api) => {
        check();
        return api.listRetiredLeaseIdentifiers(props.tomb);
      })
      .then((rows) => {
        if (alive) {
          check();
          setIssued(rows);
        }
      })
      .catch(() => {
        if (alive) setIssued([]);
      });
    return () => {
      alive = false;
    };
  }, [props.tomb]);
  if (!issued.length) return null;
  return (
    <>
      <p>
        Revoked local agent leases from this running owner session. Reloading
        clears the issuer inventory.
      </p>
      {issued.map((record, index) => (
        <CeremonyRow
          icon={<IconBell size={16} />}
          key={record.issuerRecordRef}
          label={`Revoked agent lease ${index + 1}`}
          sub={`Generation ${record.context.generation}`}
          action={
            <IconKey
              label={`Monitor revoked agent lease ${index + 1}`}
              small
              disabled={props.disabled}
              onClick={() => {
                void props.retire(record.issuerRecordRef);
              }}
            >
              <IconBell size={16} />
            </IconKey>
          }
        />
      ))}
    </>
  );
}
