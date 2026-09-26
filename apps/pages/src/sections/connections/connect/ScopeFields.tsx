import type { OauthDraft } from "@opensesame/app-core/lib/connect-create.js";
import {
  type DraftState,
  scopeChoices,
  toggleScope,
} from "@opensesame/app-core/lib/connect-draft.js";
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconPlus, IconTrash } from "../../../components/Icons.js";

/** The scopes a person grants, with the preset's own words for each. */
export function ScopeFields({
  plan,
  state,
  onState,
}: {
  plan: ConnectPlan;
  state: DraftState;
  onState: (next: DraftState) => void;
}) {
  const [extra, setExtra] = useState("");
  const add = () => {
    const scope = extra.trim();
    if (scope && !state.oauth.scopes.includes(scope)) {
      onState(toggleScope(state, scope));
    }
    setExtra("");
  };
  return (
    <fieldset className="conn-scope-picker cx-block">
      <legend>User token scopes</legend>
      {scopeChoices(plan, state).map((scope) => (
        <label className="check" key={scope.name}>
          <input
            type="checkbox"
            checked={state.oauth.scopes.includes(scope.name)}
            onChange={() => onState(toggleScope(state, scope.name))}
          />
          <span>
            <code>{scope.name}</code>
            {scope.description ? (
              <span className="hint">{scope.description}</span>
            ) : null}
          </span>
        </label>
      ))}
      <FieldShell
        label="Another scope"
        value={extra}
        mono
        onValueChange={setExtra}
        onEnter={add}
        tail={
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Add scope"
            title="Add scope"
            disabled={!extra.trim()}
            onClick={add}
          >
            <IconPlus size={14} />
          </button>
        }
      />
    </fieldset>
  );
}

type ParamRow = readonly [key: string, value: string];

/**
 * The object a request carries: named rows only, and the first row of a name
 * wins, so typing a name that already exists into a new row never overwrites
 * the value the earlier row holds.
 */
function paramsOf(
  rows: readonly ParamRow[],
): OauthDraft["authorizationParams"] {
  const params: OauthDraft["authorizationParams"] = {};
  for (const [key, value] of rows) {
    if (key.trim() !== "" && !Object.hasOwn(params, key)) params[key] = value;
  }
  return params;
}

/**
 * Extra query parameters every authorization URL carries. The rows are this
 * field's own, so a blank row being typed into, or two rows naming the same
 * param for a moment, survive until the person finishes; only the object
 * built from them goes to the draft. A change from outside (a preset filled
 * from a domain) replaces the rows.
 */
export function AuthorizationParams({
  params,
  onParams,
}: {
  params: Record<string, string>;
  onParams: (next: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<readonly ParamRow[]>(() =>
    Object.entries(params),
  );
  const incoming = JSON.stringify(params);
  const [seen, setSeen] = useState(incoming);
  if (incoming !== seen && incoming !== JSON.stringify(paramsOf(rows))) {
    setSeen(incoming);
    setRows(Object.entries(params));
  }
  const update = (next: readonly ParamRow[]) => {
    setRows(next);
    const built = paramsOf(next);
    setSeen(JSON.stringify(built));
    onParams(built);
  };
  const set = (index: number, key: string, value: string) =>
    update(
      rows.map((row, at): ParamRow => (at === index ? [key, value] : row)),
    );
  return (
    <fieldset className="cx-block">
      <legend>Additional authorization params</legend>
      {rows.map(([key, value], index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; renaming a param must not remount the field being typed in.
        <div className="cx-param" key={index}>
          <FieldShell
            label={`Param ${index + 1}`}
            value={key}
            mono
            onValueChange={(next) => set(index, next, value)}
          />
          <FieldShell
            label={`Param ${index + 1} value`}
            value={value}
            mono
            onValueChange={(next) => set(index, key, next)}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove ${key || "param"}`}
            title={`Remove ${key || "param"}`}
            onClick={() => update(rows.filter((_, at) => at !== index))}
          >
            <IconTrash size={16} />
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Add param"
          title="Add param"
          onClick={() => setRows([...rows, ["", ""]])}
        >
          <IconPlus size={16} />
        </button>
      </div>
    </fieldset>
  );
}
