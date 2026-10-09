/** Spending passes and reserved attempts use the wallet's record workspace. */
import {
  listSpendingLeases,
  removeSpendingLease,
} from "@opensesame/app-core/lib/spending-leases.js";
import {
  formatUnits,
  getSpendingLedger,
} from "@opensesame/app-core/lib/spending-ledger.js";
import { safeMerchantLabel } from "@opensesame/app-core/lib/wallet-safe-label.js";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { FieldRow } from "../../components/FieldRow.js";
import { IconRefresh, IconTrash, IconX } from "../../components/Icons.js";
import {
  RecordWorkspace,
  type WorkspaceRow,
} from "../../components/RecordWorkspace.js";
import { StatusMark, type StatusTone } from "../../components/StatusMark.js";
import { StatusNote } from "../../components/StatusNote.js";
import {
  useWalletRecords,
  walletRecordId,
  walletRecordPath,
  walletRecordsChanged,
} from "./records.js";

const LIST_PATH = "/wallet/passes";
type PassRecord = WorkspaceRow & {
  kind: string;
  status: string;
  tone: StatusTone;
  fields: { label: string; value: string }[];
  remove: () => void;
  removeLabel: string;
};

function passRecords(): PassRecord[] {
  const leases = listSpendingLeases().map(
    (lease): PassRecord => ({
      id: `lease:${lease.id}`,
      label: `${lease.amount} ${lease.currency} → ${safeMerchantLabel(lease.recipient)}`,
      extension: "pass",
      to: walletRecordPath(LIST_PATH, `lease:${lease.id}`),
      kind: "Spending pass",
      status: lease.status,
      tone: lease.status === "active" ? "ok" : "idle",
      fields: [
        { label: "Amount", value: `${lease.amount} ${lease.currency}` },
        { label: "Recipient", value: safeMerchantLabel(lease.recipient) },
        { label: "Valid from", value: lease.validFrom },
        { label: "Valid until", value: lease.validUntil },
        { label: "Allocation", value: lease.allocationRef },
        { label: "Beneficiary", value: lease.beneficiaryRef },
      ],
      remove: () => removeSpendingLease(lease.id),
      removeLabel: `Remove lease ${lease.id}`,
    }),
  );
  const attempts = [...getSpendingLedger().snapshot().attempts.values()]
    .filter((attempt) => attempt.state === "reserved")
    .map(
      (attempt): PassRecord => ({
        id: `attempt:${attempt.attemptId}`,
        label: `${formatUnits(attempt.amount)} on ${attempt.nodeId}`,
        extension: "reservation",
        to: walletRecordPath(LIST_PATH, `attempt:${attempt.attemptId}`),
        kind: "Reservation",
        status: "Reserved",
        tone: "idle",
        fields: [
          { label: "Amount", value: formatUnits(attempt.amount) },
          { label: "Budget", value: attempt.nodeId },
          { label: "Reference", value: attempt.attemptId },
        ],
        remove: () => getSpendingLedger().release(attempt.attemptId),
        removeLabel: `Release ${attempt.attemptId}`,
      }),
    );
  return [...leases, ...attempts];
}

function PassDetail({
  record,
  armed,
  onRemove,
  onCancel,
}: {
  record: PassRecord;
  armed: boolean;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const label = armed ? `Confirm ${record.removeLabel}` : record.removeLabel;
  return (
    <div className="detail">
      <div className="detail__head">
        <div className="detail__heading">
          <h1>{record.label}</h1>
          <div className="detail__meta">
            {record.kind}
            <StatusMark tone={record.tone} label={record.status} />
          </div>
        </div>
        <div className="detail__tools">
          <button
            type="button"
            className={`icon-btn icon-btn--sm${armed ? " is-armed" : ""}`}
            aria-label={label}
            title={label}
            onClick={onRemove}
          >
            <IconTrash size={15} />
          </button>
          {armed ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Keep this pass"
              title="Keep this pass"
              onClick={onCancel}
            >
              <IconX size={15} />
            </button>
          ) : null}
        </div>
      </div>
      <section className="detail__group">
        <h2 className="detail__grouphead">{record.kind}</h2>
        {record.fields.map((field) => (
          <FieldRow key={field.label} label={field.label}>
            <span className="frow__value">{field.value}</span>
          </FieldRow>
        ))}
      </section>
    </div>
  );
}

export function PassesPanel() {
  useWalletRecords();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [armedId, setArmedId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "err"; text: string } | null>(
    null,
  );
  const rows = passRecords();
  const selectedId = walletRecordId(hash);
  const selected = rows.find((record) => record.id === selectedId);
  const onRemove = () => {
    if (!selected) return;
    if (armedId !== selected.id) {
      setArmedId(selected.id);
      return;
    }
    setArmedId(null);
    setMessage(null);
    try {
      selected.remove();
      walletRecordsChanged();
      navigate(LIST_PATH);
    } catch (caught) {
      setMessage({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Could not release",
      });
    }
  };
  return (
    <RecordWorkspace
      section="Wallet"
      title="Spending passes"
      rootPath="/wallet"
      listPath={LIST_PATH}
      rows={rows}
      selectedId={selectedId}
      status={message ? <StatusNote message={message} /> : null}
      commands={
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          onClick={walletRecordsChanged}
          aria-label="Reload spending passes"
          title="Reload spending passes"
        >
          <IconRefresh size={15} />
        </button>
      }
    >
      {selected ? (
        <PassDetail
          record={selected}
          armed={armedId === selected.id}
          onRemove={onRemove}
          onCancel={() => setArmedId(null)}
        />
      ) : null}
    </RecordWorkspace>
  );
}
