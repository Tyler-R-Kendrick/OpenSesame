import type {
  ParseResult,
  SourceId,
} from "@opensesame/app-core/lib/vault/import/index.js";
import type { MergePlan } from "@opensesame/app-core/lib/vault/import/merge.js";
import {
  type LandingChoice,
  commitLabel,
  defaultFolderName,
  exportFolders,
  plural,
  previewFacts,
  previewRows,
} from "@opensesame/app-core/sections/vault/import/preview.js";
import type { Folder } from "@opensesame/vault-core";
import { useId } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconFolder } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { ErrorMark, FormatField } from "./ImportCards.js";

type PreviewProps = {
  fileName: string;
  result: ParseResult;
  plan: MergePlan;
  choice: LandingChoice;
  folders: Folder[];
  busy: boolean;
  error: string | null;
  setChoice: (next: LandingChoice) => void;
  reparse: (source: SourceId) => void;
  confirm: () => void;
};

/** Where the items land. An export with no folders has none to recreate. */
function LandingFields({
  result,
  choice,
  setChoice,
}: Pick<PreviewProps, "result" | "choice" | "setChoice">) {
  const name = useId();
  const named = exportFolders(result);
  const radio = (
    mode: LandingChoice["mode"],
    label: string,
    extra?: string,
  ) => (
    <label className="check">
      <input
        type="radio"
        name={name}
        checked={choice.mode === mode}
        onChange={() => setChoice({ ...choice, mode })}
      />
      <span>
        {label}
        {extra ? <em className="imp__folderlist">{extra}</em> : null}
      </span>
    </label>
  );
  const listed =
    named.slice(0, 6).join(", ") +
    (named.length > 6 ? `, and ${named.length - 6} more` : "");
  return (
    <fieldset className="imp__options">
      <legend>Where these land</legend>
      {named.length > 0
        ? radio(
            "keep",
            `Recreate the ${plural(named.length, "folder", "folders")} from the export`,
            listed,
          )
        : null}
      {radio("single", "Put everything in one new folder")}
      {choice.mode === "single" ? (
        <FieldShell
          label="Folder name"
          value={choice.folderName}
          placeholder={defaultFolderName(result.source)}
          lead={<IconFolder size={16} />}
          onValueChange={(folderName) => setChoice({ ...choice, folderName })}
        />
      ) : null}
      {radio("none", named.length > 0 ? "No folders" : "Leave them unfiled")}
    </fieldset>
  );
}

function PreviewTable({
  plan,
  folders,
}: { plan: MergePlan; folders: Folder[] }) {
  const { rows, hidden } = previewRows(plan, folders);
  if (rows.length === 0) return null;
  return (
    <div
      className="imp__table"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the preview scrolls, and a scroll container keyboard focus cannot reach is unreadable.
      tabIndex={0}
      aria-label="Items to be imported"
    >
      <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Detail</th>
            <th scope="col">Folder</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.name}</th>
              <td>{row.detail}</td>
              <td>{row.folder}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <p className="imp__more">
          first {rows.length} of {rows.length + hidden}
        </p>
      ) : null}
    </div>
  );
}

function LeftOut({ result }: { result: ParseResult }) {
  if (result.skipped.length === 0) return null;
  return (
    <details className="imp__skipped">
      <summary>
        {plural(result.skipped.length, "record", "records")} left out
      </summary>
      <ul>
        {result.skipped.map((record) => (
          <li key={`${record.name}-${record.reason}`}>
            <strong>{record.name}</strong>
            <span>{record.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The reviewed preview: the file's facts, its format, where the items
 * land, whether copies are skipped, and the rows the merge will write —
 * then one commit that states the real number.
 */
export function ImportPreview(props: PreviewProps) {
  const { result, plan, choice } = props;
  const allHere = plan.items.length === 0 && plan.duplicates.length > 0;
  return (
    <CeremonyShell
      ok={props.error === null}
      name={props.fileName}
      facts={previewFacts(result, plan)}
      primary={{
        label: commitLabel(plan),
        busy: props.busy,
        disabled: plan.items.length === 0,
        onClick: props.confirm,
      }}
    >
      <div className="imp__preview">
        <FormatField value={result.source} onPick={props.reparse} />
        {props.error ? (
          <p className="imp__marks">
            <ErrorMark error={props.error} />
          </p>
        ) : null}
        <LandingFields
          result={result}
          choice={choice}
          setChoice={props.setChoice}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={choice.skipDuplicates}
            onChange={(event) =>
              props.setChoice({
                ...choice,
                skipDuplicates: event.target.checked,
              })
            }
          />
          <span>Skip items this vault already has</span>
        </label>
        {allHere ? (
          <p className="imp__marks">
            <StatusMark tone="ok" label="Every item is already in this vault" />
          </p>
        ) : (
          <PreviewTable plan={plan} folders={props.folders} />
        )}
        <LeftOut result={result} />
      </div>
    </CeremonyShell>
  );
}
