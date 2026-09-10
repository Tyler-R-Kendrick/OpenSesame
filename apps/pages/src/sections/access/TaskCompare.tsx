import {
  type BoundaryValue,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { TaskDetail } from "../../lib/access.js";

type Cap = { action: string; resource: string; values: string[] };

/** Host serialises a Rust `CapabilitySet`; older shapes send a flat array. */
function readCap(raw: BoundaryValue): Cap | null {
  if (!raw || !isTypeofObject(raw)) return null;
  const obj = overlapCast(raw);
  const action = isString(obj.action) ? obj.action : "";
  if (!action) return null;
  const resource = obj.resource;
  if (isString(resource)) {
    return { action, resource, values: [resource] };
  }
  if (resource && isTypeofObject(resource)) {
    const sel = overlapCast(resource);
    if (isString(sel.value)) {
      return { action, resource: sel.value, values: [sel.value] };
    }
    if (Array.isArray(sel.values)) {
      const values = sel.values.filter((v): v is string => isString(v));
      if (values.length > 0) {
        return { action, resource: values.join(", "), values };
      }
    }
  }
  return null;
}

function readCaps(raw: BoundaryValue): Cap[] {
  let list: BoundaryValue[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && isTypeofObject(raw)) {
    const inner = overlapCast(raw).capabilities;
    if (Array.isArray(inner)) list = inner;
  }
  return list.map(readCap).filter((c): c is Cap => c !== null);
}

type RowState = "held" | "narrowed" | "released" | "outside";
type CompareRow = {
  key: string;
  action: string;
  resource: string;
  state: RowState;
  detail: string;
};

function compareCeiling(ceiling: Cap[], current: Cap[]): CompareRow[] {
  const rows: CompareRow[] = ceiling.map((cap, i) => {
    const at = { key: `ceil-${i}`, action: cap.action, resource: cap.resource };
    const match = current.find(
      (held) =>
        held.action === cap.action &&
        held.values.some((v) => cap.values.includes(v)),
    );
    if (!match) {
      return {
        ...at,
        state: "released",
        detail: "Released — not held in this task",
      };
    }
    const kept = match.values.filter((v) => cap.values.includes(v));
    if (kept.length === cap.values.length) {
      return { ...at, state: "held", detail: "Held in full" };
    }
    return {
      ...at,
      state: "narrowed",
      detail: `Narrowed to ${kept.join(", ")}`,
    };
  });

  current.forEach((held, i) => {
    const covered = ceiling.some(
      (cap) =>
        cap.action === held.action &&
        held.values.every((v) => cap.values.includes(v)),
    );
    if (!covered) {
      rows.push({
        key: `extra-${i}`,
        action: held.action,
        resource: held.resource,
        state: "outside",
        detail: "Held but outside the ceiling — report this Host",
      });
    }
  });

  return rows;
}

const STATUS_TONE = new Map([
  ["active", "chip--ok"],
  ["failed", "chip--err"],
  ["cancelled", "chip--err"],
  ["restricting", "chip--warn"],
  ["pending", "chip--warn"],
]);

const ROW_CHIP = {
  held: "chip--ok",
  narrowed: "chip--accent",
  outside: "chip--err",
  released: "chip--warn",
};

export function statusTone(status: string): string {
  return STATUS_TONE.get(status) ?? "";
}

function rowChip(state: RowState): string {
  return ROW_CHIP[state];
}

export function TaskCompare({ detail }: { detail: TaskDetail }) {
  const rows = compareCeiling(
    readCaps(detail.capabilityCeiling),
    readCaps(detail.currentCapabilities),
  );

  return (
    <div className="access-task">
      <dl className="kv">
        <div>
          <dt>Task run</dt>
          <dd>
            <code>{detail.taskRunId}</code>
          </dd>
        </div>
        <div>
          <dt>State version</dt>
          <dd>{detail.stateVersion}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`chip ${statusTone(detail.status)}`}>
              {detail.status}
            </span>
          </dd>
        </div>
      </dl>

      {rows.length > 0 ? (
        <div className="scroll-x">
          <table className="table access-compare">
            <thead>
              <tr>
                <th scope="col">Ceiling — action</th>
                <th scope="col">Ceiling — resource</th>
                <th scope="col">In this task</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <span className="access-cap__action">
                      {row.state === "outside" ? "—" : row.action}
                    </span>
                  </td>
                  <td className="access-compare__res">
                    {row.state === "outside" ? "—" : row.resource}
                  </td>
                  <td>
                    <span className={`chip ${rowChip(row.state)}`}>
                      {row.state === "outside"
                        ? `${row.action} → ${row.resource}`
                        : row.detail}
                    </span>
                    {row.state === "outside" ? (
                      <span className="access-compare__warn">{row.detail}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <output className="note">No capabilities.</output>
      )}
    </div>
  );
}
