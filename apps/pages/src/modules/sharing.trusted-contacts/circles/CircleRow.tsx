/**
 * One circle in the Circles panel: its name, its rule, epoch and contacts, a
 * mark for where it stands, and the one key that opens it. The row is the
 * shell's (`tc-row`) with a key at its end.
 */

import type { ReactNode } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconChevronRight } from "../../../components/Icons.js";

export function CircleRow({
  keyId,
  name,
  facts,
  marks,
  onOpen,
}: {
  keyId: string;
  name: string;
  facts: string;
  marks: ReactNode;
  onOpen: () => void;
}) {
  return (
    <li className="tc-row tcc-row">
      <h3>{name}</h3>
      <span className="tc-row__facts">{facts}</span>
      <span className="tc-row__marks">{marks}</span>
      <IconKey id={keyId} small label={`Open ${name}`} onClick={onOpen}>
        <IconChevronRight size={16} />
      </IconKey>
    </li>
  );
}
