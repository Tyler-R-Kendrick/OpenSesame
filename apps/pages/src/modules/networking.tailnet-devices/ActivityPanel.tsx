/**
 * What was changed on the tailnet through the daemon, newest first: when,
 * by which pairing, to which device or key, and whether it took (ADR 0166
 * §5). The daemon keeps it; no value is in it.
 */

import {
  relativeTo,
  shortName,
} from "@opensesame/app-core/lib/tailnet-admin/model.js";
import type { TailnetAuditEntry } from "@opensesame/app-core/lib/tailnet-admin/wire.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { TailnetModel } from "./use-tailnet-admin.js";

const SAID: ReadonlyArray<[string, string]> = [
  ["device.authorize", "Approved"],
  ["device.deauthorize", "Put out"],
  ["device.rename", "Renamed"],
  ["device.tags", "Tagged"],
  ["device.key_expiry", "Changed key expiry for"],
  ["device.expire", "Expired the key of"],
  ["device.routes", "Changed routes of"],
  ["device.delete", "Removed"],
  ["key.create", "Minted the auth key"],
  ["key.delete", "Revoked the auth key"],
];

/** A device or key still on the tailnet by its name; one that is gone by its id. */
function targetName(model: TailnetModel, target: string): string {
  const device = model.loaded?.devices.find((d) => d.id === target);
  if (device) return shortName(device);
  const key = model.loaded?.keys.find((k) => k.id === target);
  return key?.description || target;
}

function line(model: TailnetModel, entry: TailnetAuditEntry): string {
  const verb =
    SAID.find(([action]) => action === entry.action)?.[1] ?? entry.action;
  return `${verb} ${targetName(model, entry.target)}`.trim();
}

/** The newest entries shown; the daemon keeps more. */
const SHOWN = 20;

export function ActivityPanel({ model }: { model: TailnetModel }) {
  const entries = (model.loaded?.audit ?? []).slice(0, SHOWN);
  const now = model.loaded?.at ?? Date.now();
  return (
    <section className="panel" aria-label="Tailnet activity">
      <div className="panel__head">
        <h2>Activity</h2>
      </div>
      <div className="panel__body">
        {entries.length === 0 ? (
          <div className="actions">
            <StatusMark
              tone="idle"
              label="Nothing changed through this daemon yet."
            />
          </div>
        ) : null}
        <ul className="identity-rows tailnet-activity">
          {entries.map((entry) => (
            <li
              key={`${entry.at}-${entry.action}-${entry.target}`}
              className="identity-row"
            >
              <div className="identity-row__id">
                <div className="identity-row__title">
                  <span>{line(model, entry)}</span>
                  <StatusMark
                    tone={entry.status < 300 ? "ok" : "err"}
                    label={
                      entry.status < 300 ? "Done" : `Refused (${entry.status})`
                    }
                  />
                </div>
                <span className="identity-row__when">
                  {[
                    entry.label || entry.pairing,
                    relativeTo(new Date(entry.at * 1000).toISOString(), now),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
