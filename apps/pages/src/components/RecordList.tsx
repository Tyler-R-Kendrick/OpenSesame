import { openVaultLabel } from "@opensesame/app-core/lib/vaults.js";
import { Link } from "react-router";
import { showKeymapHelp } from "../lib/keymap.js";
import { CrumbTrail } from "./Crumbs.js";
import { IconChevronLeft } from "./Icons.js";
import { RecordRows } from "./RecordRows.js";
import type { RecordWorkspaceProps } from "./RecordWorkspace.js";
import { UpLink } from "./UpLink.js";
import type { useRecordWorkspace } from "./record-workspace-state.js";
type Props = RecordWorkspaceProps & {
  model: ReturnType<typeof useRecordWorkspace>;
};
function RecordPathbar({ section, title, rootPath, commands, model }: Props) {
  const { crumbs } = model;
  return (
    <div className="vtree__pathbar">
      <CrumbTrail
        crumbs={crumbs}
        className="vtree__crumbs"
        label={`${section} path`}
      />
      <fieldset className="vtree__keys" aria-label={`${title} commands`}>
        <UpLink
          pane="tree"
          to={rootPath}
          className="icon-btn icon-btn--sm vault__back"
          aria-label="Back to sections"
          title="Back to sections"
        >
          <IconChevronLeft size={15} />
        </UpLink>
        <Link
          to={rootPath}
          className="record-workspace__view choice"
          title="Choose a view"
        >
          {title}
        </Link>
        <span
          className={`record-workspace__commands${model.createLabel ? "" : " record-workspace__commands--utility"}`}
        >
          {commands}
        </span>
        <button
          type="button"
          className="vtree__key vtree__key--help"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={showKeymapHelp}
        >
          ?
        </button>
      </fieldset>
    </div>
  );
}
export function RecordList(props: Props) {
  const { section, title, listHeader, rows, model } = props;
  const { list, tree, cursor, shown, selected, needle } = model;
  return (
    <div className="vault__list" ref={list}>
      <div className="vtree">
        <RecordPathbar {...props} model={model} />
        {listHeader}
        <div
          ref={tree}
          className="vtree__rows"
          role="tree"
          aria-label={`${title} items`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: tree owns the listing's single tab stop
          tabIndex={0}
          aria-activedescendant={
            cursor ? `record-${section}-${cursor}` : undefined
          }
        >
          <RecordRows {...props} model={model} />
        </div>
        <div className="vault__status">
          <span className="vault__status-path">
            {openVaultLabel()}:/{section.toLowerCase()}/
            {selected?.label ?? title}
          </span>
          <span className="vault__status-meta">
            {shown.length}
            {needle ? `/${rows.length}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
