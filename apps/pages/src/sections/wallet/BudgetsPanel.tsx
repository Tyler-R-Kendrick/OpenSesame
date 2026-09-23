/**
 * Wallet › Budgets — conserved local ledger (ADR 0123).
 *
 * Add, edit, and remove root budgets. Amounts are integer subunits.
 */

import {
  BudgetError,
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
import { type FormEvent, useCallback, useState } from "react";
import {
  IconCheck,
  IconEdit,
  IconPlus,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import { useVault } from "../../lib/vault/hooks.js";

type Draft = {
  readonly nodeId: string | null;
  readonly name: string;
  readonly ceiling: string;
  readonly itemIds: readonly string[];
};

function failText(caught: BoundaryValue): string {
  if (caught instanceof BudgetError) return caught.message;
  if (caught instanceof Error) return caught.message;
  return "Could not update budget";
}

export function BudgetsPanel() {
  const { items } = useVault();
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "warn";
    text: string;
  } | null>(null);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  void tick;
  const rows = listBudgetRows();
  const instruments = listPaymentInstruments(items);

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    if (draft === null) return;
    setMessage(null);
    try {
      const ceiling = parseCeiling(draft.ceiling);
      const saved =
        draft.nodeId === null
          ? createBudget({ name: draft.name, ceiling })
          : updateBudget({
              nodeId: draft.nodeId,
              name: draft.name,
              ceiling,
            });
      setBudgetInstruments(saved.nodeId, draft.itemIds);
      setDraft(null);
      refresh();
    } catch (caught) {
      setMessage({ tone: "err", text: failText(overlapCast(caught)) });
    }
  };

  const onRemove = (nodeId: string, label: string) => {
    setMessage(null);
    try {
      removeBudget(nodeId);
      unbindBudget(nodeId);
      if (draft?.nodeId === nodeId) setDraft(null);
      refresh();
    } catch (caught) {
      setMessage({
        tone: "err",
        text: failText(overlapCast(caught)) || `Could not remove ${label}`,
      });
    }
  };

  return (
    <section className="panel" aria-labelledby="wallet-budgets">
      <div className="panel__head">
        <div>
          <h2 id="wallet-budgets">Budgets</h2>
        </div>
        <fieldset className="vtree__keys" aria-label="Budget commands">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Add budget"
            title="Add budget"
            disabled={draft !== null}
            onClick={() =>
              setDraft({ nodeId: null, name: "", ceiling: "0", itemIds: [] })
            }
          >
            <IconPlus size={15} />
          </button>
        </fieldset>
      </div>
      <div className="panel__body">
        {rows.length === 0 && draft === null ? (
          <div className="empty">
            <h3>No budgets yet</h3>
          </div>
        ) : (
          <ul className="identity-rows">
            {rows.map((row) => {
              const assigned = instrumentIdsForBudget(row.nodeId)
                .map((id) => instruments.find((item) => item.id === id)?.name)
                .filter((name): name is string => Boolean(name));
              return (
                <li key={row.nodeId} className="identity-row">
                  <div className="identity-row__main">
                    <div className="identity-row__id">
                      <h3>{row.label}</h3>
                      <span className="identity-ref">
                        {formatUnits(row.ceiling)} ·{" "}
                        {formatUnits(row.locallyAvailable)} left
                        {assigned.length > 0 ? ` · ${assigned.join(", ")}` : ""}
                      </span>
                    </div>
                    <fieldset
                      className="vtree__keys actions"
                      aria-label={`${row.label} actions`}
                    >
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm"
                        aria-label={`Edit ${row.label}`}
                        title={`Edit ${row.label}`}
                        onClick={() =>
                          setDraft({
                            nodeId: row.nodeId,
                            name: row.label,
                            ceiling: row.ceiling.toString(10),
                            itemIds: instrumentIdsForBudget(row.nodeId),
                          })
                        }
                      >
                        <IconEdit size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm"
                        aria-label={`Remove ${row.label}`}
                        title={`Remove ${row.label}`}
                        onClick={() => onRemove(row.nodeId, row.label)}
                      >
                        <IconTrash size={15} />
                      </button>
                    </fieldset>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {draft ? (
          <form onSubmit={onSave}>
            <div className="field">
              <label className="label" htmlFor="budget-name">
                Name
              </label>
              <input
                id="budget-name"
                required
                maxLength={80}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="budget-ceiling">
                Ceiling (subunits)
              </label>
              <input
                id="budget-ceiling"
                inputMode="numeric"
                required
                pattern="[0-9]+"
                value={draft.ceiling}
                onChange={(event) =>
                  setDraft({ ...draft, ceiling: event.target.value })
                }
              />
            </div>
            {instruments.length > 0 ? (
              <fieldset className="field">
                <legend className="label">Payment methods</legend>
                {instruments.map((item) => {
                  const checked = draft.itemIds.includes(item.id);
                  return (
                    <label className="check" key={item.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setDraft({
                            ...draft,
                            itemIds: checked
                              ? draft.itemIds.filter((id) => id !== item.id)
                              : [...draft.itemIds, item.id],
                          });
                        }}
                      />{" "}
                      {item.name}
                    </label>
                  );
                })}
              </fieldset>
            ) : null}
            <div className="actions">
              <button
                type="submit"
                className="icon-btn"
                aria-label="Save budget"
                title="Save budget"
              >
                <IconCheck size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setDraft(null)}
                aria-label="Cancel"
                title="Cancel"
              >
                <IconX size={16} />
              </button>
            </div>
          </form>
        ) : null}

        {message ? <StatusNote message={message} /> : null}
      </div>
    </section>
  );
}
