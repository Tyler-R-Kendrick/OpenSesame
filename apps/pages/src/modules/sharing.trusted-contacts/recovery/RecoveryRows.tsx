/**
 * The Recovery panel's two kinds of row (ADR 0187 §10): a recovery still
 * gathering what it needs, with the key that opens its sheet, and what a
 * finished one handed back, with the two keys it can leave by.
 *
 * Both reuse the shared row's classes (`tc-row`) and add the keys at its end.
 */

import type { RecoveryView } from "@opensesame/app-core/lib/quorum/desk/index.js";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconChevronRight,
  IconDownload,
  IconVault,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { recoveryFacts, recoveryMark } from "../row-model.js";
import type { Recovered } from "./use-recovered.js";

/** The id of the key that opens a recovery's sheet, so a ceremony can land the keyboard on it. */
export const openKeyId = (requestId: string) => `recovery-open-${requestId}`;

/** The id of a recovered row's Save key, where the keyboard lands when a recovery opens. */
export const saveKeyId = (requestId: string) => `recovered-save-${requestId}`;

export function RecoveryRow({
  view,
  onOpen,
}: {
  view: RecoveryView;
  onOpen: () => void;
}) {
  const mark = recoveryMark(view.status);
  return (
    <li className="tc-row rc-row">
      <h3>{view.label}</h3>
      <span className="tc-row__facts">
        {recoveryFacts(view.approvedBy, view.releasedBy)}
      </span>
      <span className="tc-row__marks">
        <StatusMark tone={mark.tone} label={mark.label} />
      </span>
      <span className="rc-row__keys">
        <IconKey
          id={openKeyId(view.requestId)}
          label={`Open ${view.label} recovery`}
          small
          onClick={onOpen}
        >
          <IconChevronRight size={15} />
        </IconKey>
      </span>
    </li>
  );
}

export function RecoveredRow({
  item,
  failure,
  onSave,
  onImport,
}: {
  item: Recovered;
  /** The sentence for why ending the recovery did not work; empty otherwise. */
  failure: string;
  onSave: () => void;
  onImport: () => void;
}) {
  return (
    <li className="tc-row rc-row">
      <h3>{item.label}</h3>
      <span className="tc-row__facts">Recovered</span>
      <span className="tc-row__marks">
        {item.safe === null ? (
          <StatusMark tone="warn" label="Not saved yet" />
        ) : (
          <StatusMark
            tone="ok"
            label={
              item.safe === "file" ? "Saved to a file" : "Put in this vault"
            }
          />
        )}
        {failure ? <StatusMark tone="err" label={failure} /> : null}
      </span>
      <span className="rc-row__keys">
        <IconKey
          id={saveKeyId(item.requestId)}
          label="Save the recovered items"
          small
          onClick={onSave}
        >
          <IconDownload size={15} />
        </IconKey>
        <IconKey
          id={`recovered-import-${item.requestId}`}
          label="Put them in this vault"
          small
          onClick={onImport}
        >
          <IconVault size={15} />
        </IconKey>
      </span>
    </li>
  );
}
