/** Wallet budgets keep their local ledger and vault-style record navigation. */
import {
  BudgetError,
  type BudgetRow,
  createBudget,
  formatUnits,
  listBudgetRows,
  parseCeiling,
  removeBudget,
  updateBudget,
} from "@opensesame/app-core/lib/spending-ledger.js";
import {
  instrumentIdsForBudget,
  setBudgetInstruments,
  unbindBudget,
} from "@opensesame/app-core/lib/wallet-assignments.js";
import { listPaymentInstruments } from "@opensesame/app-core/lib/wallet-instruments.js";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { type FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { FieldRow } from "../../components/FieldRow.js";
import { FormCommit } from "../../components/FormCommit.js";
import {
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { StatusNote } from "../../components/StatusNote.js";
import { useVault } from "../../lib/vault/hooks.js";
import {
  useWalletRecords,
  walletRecordId,
  walletRecordPath,
  walletRecordsChanged,
} from "./records.js";

type Draft = {
  readonly nodeId: string | null;
  readonly name: string;
  readonly ceiling: string;
  readonly itemIds: readonly string[];
};
const LIST_PATH = "/wallet/budgets";

function failText(caught: BoundaryValue): string {
  if (caught instanceof BudgetError || caught instanceof Error)
    return caught.message;
  return "Could not update budget";
}

function BudgetEditor({
  initial,
  onSave,
}: { initial: Draft; onSave: (draft: Draft) => void }) {
  const { items } = useVault();
  const instruments = listPaymentInstruments(items);
  const [draft, setDraft] = useState(initial);
  const cancelPath = initial.nodeId
    ? walletRecordPath(LIST_PATH, initial.nodeId)
    : LIST_PATH;
  return (
    <form
      className="detail editor"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <div className="detail__head">
        <div className="detail__heading">
          <div className="editor__titlerow">
            <input
              className="editor__name"
              id="budget-name"
              aria-label="Name"
              placeholder="Budget name"
              required
              maxLength={80}
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
            <span className="vtree__dim">.budget</span>
          </div>
        </div>
      </div>
      <section className="detail__group">
        <h2 className="detail__grouphead">Budget</h2>
        <div className="field">
          <label htmlFor="budget-ceiling">Ceiling (subunits)</label>
          <input
            id="budget-ceiling"
            aria-label="Ceiling (subunits)"
            inputMode="numeric"
            required
            pattern="[0-9]+"
            value={draft.ceiling}
            onChange={(event) =>
              setDraft({ ...draft, ceiling: event.target.value })
            }
          />
        </div>
      </section>
      {instruments.length > 0 ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Payment methods</h2>
          {instruments.map((item) => {
            const checked = draft.itemIds.includes(item.id);
            return (
              <FieldRow key={item.id} label={item.name}>
                <label className="check">
                  <input
                    type="checkbox"
                    aria-label={item.name}
                    checked={checked}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        itemIds: checked
                          ? draft.itemIds.filter((id) => id !== item.id)
                          : [...draft.itemIds, item.id],
                      })
                    }
                  />
                </label>
              </FieldRow>
            );
          })}
        </section>
      ) : null}
      <FormCommit label="Save budget">
        <Link
          className="icon-btn"
          to={cancelPath}
          aria-label="Cancel"
          title="Cancel"
        >
          <IconX size={16} />
        </Link>
      </FormCommit>
    </form>
  );
}

function BudgetDetail({
  selected,
  armed,
  onRemove,
  onCancel,
}: {
  selected: BudgetRow;
  armed: boolean;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const { items } = useVault();
  const instruments = listPaymentInstruments(items);
  const removeLabel = armed
    ? `Confirm remove ${selected.label}`
    : `Remove ${selected.label}`;
  return (
    <div className="detail">
      <div className="detail__head">
        <div className="detail__heading">
          <h1>{selected.label}</h1>
          <div className="detail__meta">Budget</div>
        </div>
        <fieldset
          className="vtree__keys actions"
          aria-label={`${selected.label} actions`}
        >
          <Link
            className="icon-btn icon-btn--sm"
            to={`${LIST_PATH}?edit#${encodeURIComponent(selected.nodeId)}`}
            aria-label={`Edit ${selected.label}`}
            title={`Edit ${selected.label}`}
          >
            <IconEdit size={15} />
          </Link>
          <button
            type="button"
            className={`icon-btn icon-btn--sm${armed ? " is-armed" : ""}`}
            aria-label={removeLabel}
            title={removeLabel}
            onClick={onRemove}
          >
            <IconTrash size={15} />
          </button>
          {armed ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Keep this budget"
              title="Keep this budget"
              onClick={onCancel}
            >
              <IconX size={15} />
            </button>
          ) : null}
        </fieldset>
      </div>
      <section className="detail__group">
        <h2 className="detail__grouphead">Budget</h2>
        <FieldRow label="Ceiling">
          <span className="frow__value">{formatUnits(selected.ceiling)}</span>
        </FieldRow>
        <FieldRow label="Available">
          <span className="frow__value">
            {formatUnits(selected.locallyAvailable)}
          </span>
        </FieldRow>
      </section>
      {instrumentIdsForBudget(selected.nodeId).length > 0 ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Payment methods</h2>
          {instrumentIdsForBudget(selected.nodeId).map((id) => {
            const item = instruments.find((candidate) => candidate.id === id);
            return item ? (
              <FieldRow key={id} label="Method">
                <Link to={walletRecordPath("/wallet/methods", id)}>
                  {item.name}
                </Link>
              </FieldRow>
            ) : null;
          })}
        </section>
      ) : null}
    </div>
  );
}

function BudgetCommands() {
  return (
    <>
      <Link
        className="icon-btn icon-btn--sm"
        to={`${LIST_PATH}?new`}
        aria-label="Add budget"
        title="Add budget"
      >
        <IconPlus size={15} />
      </Link>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        onClick={walletRecordsChanged}
        aria-label="Reload budgets"
        title="Reload budgets"
      >
        <IconRefresh size={15} />
      </button>
    </>
  );
}

export function BudgetsPanel() {
  useWalletRecords();
  const location = useLocation();
  const navigate = useNavigate();
  const [armedId, setArmedId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "err"; text: string } | null>(
    null,
  );
  const rows = listBudgetRows();
  const selectedId = walletRecordId(location.hash);
  const selected = rows.find((row) => row.nodeId === selectedId);
  const query = new URLSearchParams(location.search);
  const draft = query.has("new")
    ? { nodeId: null, name: "", ceiling: "0", itemIds: [] }
    : query.has("edit") && selected
      ? {
          nodeId: selected.nodeId,
          name: selected.label,
          ceiling: selected.ceiling.toString(10),
          itemIds: instrumentIdsForBudget(selected.nodeId),
        }
      : null;

  const onSave = (next: Draft) => {
    setMessage(null);
    try {
      const ceiling = parseCeiling(next.ceiling);
      const saved =
        next.nodeId === null
          ? createBudget({ name: next.name, ceiling })
          : updateBudget({ nodeId: next.nodeId, name: next.name, ceiling });
      setBudgetInstruments(saved.nodeId, next.itemIds);
      walletRecordsChanged();
      navigate(walletRecordPath(LIST_PATH, saved.nodeId));
    } catch (caught) {
      setMessage({ tone: "err", text: failText(overlapCast(caught)) });
    }
  };
  const onRemove = () => {
    if (!selected) return;
    if (armedId !== selected.nodeId) {
      setArmedId(selected.nodeId);
      return;
    }
    setArmedId(null);
    setMessage(null);
    try {
      removeBudget(selected.nodeId);
      unbindBudget(selected.nodeId);
      walletRecordsChanged();
      navigate(LIST_PATH);
    } catch (caught) {
      setMessage({ tone: "err", text: failText(overlapCast(caught)) });
    }
  };

  return (
    <RecordWorkspace
      section="Wallet"
      title="Budgets"
      rootPath="/wallet"
      listPath={LIST_PATH}
      rows={rows.map((row) => ({
        id: row.nodeId,
        label: row.label,
        extension: "budget",
        to: walletRecordPath(LIST_PATH, row.nodeId),
      }))}
      selectedId={selectedId}
      detailOpen={draft !== null}
      status={message ? <StatusNote message={message} /> : null}
      commands={<BudgetCommands />}
    >
      {draft ? (
        <BudgetEditor
          key={draft.nodeId ?? "new"}
          initial={draft}
          onSave={onSave}
        />
      ) : selected ? (
        <BudgetDetail
          selected={selected}
          armed={armedId === selected.nodeId}
          onRemove={onRemove}
          onCancel={() => setArmedId(null)}
        />
      ) : null}
    </RecordWorkspace>
  );
}
