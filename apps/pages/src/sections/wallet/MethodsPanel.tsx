/** Payment methods preview the vault record, with the same concealed fields. */
import { listBudgetRows } from "@opensesame/app-core/lib/spending-ledger.js";
import {
  assignInstrumentBudget,
  budgetIdForInstrument,
} from "@opensesame/app-core/lib/wallet-assignments.js";
import {
  listPaymentInstruments,
  paymentInstrumentKindLabel,
} from "@opensesame/app-core/lib/wallet-instruments.js";
import { type VaultItem, itemTypeId } from "@opensesame/vault-core";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconPlus, IconRefresh } from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { ItemFields } from "../vault/ItemFields.js";
import { ItemTools } from "../vault/ItemTools.js";
import { updateItemSecret } from "../vault/item-secret-update.js";
import {
  useWalletRecords,
  walletRecordId,
  walletRecordPath,
  walletRecordsChanged,
} from "./records.js";

const LIST_PATH = "/wallet/methods";

function MethodMetadata({
  item,
  revealed,
  toggle,
  copied,
  failed,
  copy,
}: {
  item: VaultItem;
  revealed: Set<string>;
  toggle: (key: string) => void;
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
}) {
  return (
    <>
      {item.fields.length > 0 ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Custom fields</h2>
          {item.fields.map((field) => (
            <FieldRow
              key={field.id}
              label={field.name || "Field"}
              actions={
                <>
                  {field.hidden ? (
                    <RevealButton
                      revealed={revealed.has(field.id)}
                      label={field.name}
                      onToggle={() => toggle(field.id)}
                    />
                  ) : null}
                  <CopyButton
                    value={field.value}
                    label={field.name}
                    fieldKey={field.id}
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                </>
              }
            >
              {field.hidden ? (
                <ConcealedValue
                  value={field.value}
                  label={field.name}
                  revealed={revealed.has(field.id)}
                />
              ) : (
                <span className="frow__value">{field.value}</span>
              )}
            </FieldRow>
          ))}
        </section>
      ) : null}
      {item.notes ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Notes</h2>
          <div className="frow">
            <p className="frow__notes">{item.notes}</p>
          </div>
        </section>
      ) : null}
    </>
  );
}

function MethodDetail({ item }: { item: VaultItem }) {
  const store = useVaultStore();
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const { copied, failed, copy } = useCopyFeedback();
  const budgets = listBudgetRows();
  const budgetId = budgetIdForInstrument(item.id);
  const toggle = (key: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="detail">
      <div className="detail__head">
        <div className="detail__heading">
          <h1>{item.name}</h1>
          <div className="detail__meta">{paymentInstrumentKindLabel(item)}</div>
        </div>
        <ItemTools
          item={item}
          listPath={LIST_PATH}
          confirmPurge={confirmPurge}
          onConfirmPurge={setConfirmPurge}
        />
      </div>
      <ItemFields
        item={item}
        revealed={revealed}
        toggle={toggle}
        copied={copied}
        failed={failed}
        copy={copy}
        onUpdateSecret={(next) => updateItemSecret(item, next, store.saveItem)}
      />
      <MethodMetadata
        item={item}
        revealed={revealed}
        toggle={toggle}
        copied={copied}
        failed={failed}
        copy={copy}
      />
      <section className="detail__group">
        <h2 className="detail__grouphead">Budget</h2>
        <FieldRow label="Budget">
          <select
            aria-label={`Budget for ${item.name}`}
            value={budgetId ?? ""}
            onChange={(event) => {
              assignInstrumentBudget(item.id, event.target.value || null);
              walletRecordsChanged();
            }}
          >
            <option value="">None</option>
            {budgets.map((budget) => (
              <option key={budget.nodeId} value={budget.nodeId}>
                {budget.label}
              </option>
            ))}
          </select>
        </FieldRow>
      </section>
      <section className="detail__group">
        <h2 className="detail__grouphead">Vault</h2>
        <FieldRow label="Item">
          <Link to={`/vault/${item.id}`}>{item.name}</Link>
        </FieldRow>
      </section>
    </div>
  );
}

export function MethodsPanel() {
  useWalletRecords();
  const { items } = useVault();
  const { hash } = useLocation();
  const rows = listPaymentInstruments(items);
  const selectedId = walletRecordId(hash);
  const selected = rows.find((item) => item.id === selectedId);
  return (
    <RecordWorkspace
      section="Wallet"
      title="Payment methods"
      rootPath="/wallet"
      listPath={LIST_PATH}
      rows={rows.map((item) => ({
        id: item.id,
        label: item.name,
        extension: itemTypeId(item),
        to: walletRecordPath(LIST_PATH, item.id),
      }))}
      selectedId={selectedId}
      commands={
        <>
          <Link
            className="icon-btn icon-btn--sm"
            to="/vault/new/card"
            aria-label="Add card"
            title="Add card"
          >
            <IconPlus size={15} />
          </Link>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            onClick={walletRecordsChanged}
            aria-label="Reload payment methods"
            title="Reload payment methods"
          >
            <IconRefresh size={15} />
          </button>
        </>
      }
    >
      {selected ? <MethodDetail key={selected.id} item={selected} /> : null}
    </RecordWorkspace>
  );
}
