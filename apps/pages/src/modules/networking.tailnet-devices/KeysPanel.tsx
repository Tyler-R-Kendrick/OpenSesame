/**
 * The tailnet's auth keys: what each lets a machine do when it joins, when it
 * expires, and — for a `manage` pairing — an armed key that revokes it. A
 * key's secret is never listed; Tailscale shows it once, when it is minted.
 */

import {
  keyFacts,
  relativeTo,
} from "@opensesame/app-core/lib/tailnet-admin/model.js";
import { IconSecret, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { byId } from "../../lib/use-focus-after.js";
import { ArmedKey } from "./ArmedKey.js";
import { ADD_DEVICE_KEY_ID } from "./DeviceRow.js";
import type { TailnetModel } from "./use-tailnet-admin.js";

export function KeysPanel({ model }: { model: TailnetModel }) {
  const keys = model.loaded?.keys ?? [];
  const now = model.loaded?.at ?? Date.now();
  return (
    <section className="panel" aria-label="Tailnet auth keys">
      <div className="panel__head">
        <h2>Auth keys</h2>
      </div>
      <div className="panel__body">
        {model.loaded?.keysError ? (
          <div className="actions">
            <StatusMark tone="err" label={model.loaded.keysError} />
          </div>
        ) : keys.length === 0 ? (
          <div className="actions">
            <StatusMark tone="idle" label="No auth keys." />
          </div>
        ) : null}
        <ul className="identity-rows">
          {keys.map((key) => {
            const name = key.description || key.id;
            const expires = relativeTo(key.expires, now);
            return (
              <li key={key.id} className="identity-row">
                <div className="identity-row__main">
                  <span className="identity-row__mark" aria-hidden="true">
                    <IconSecret size={18} />
                  </span>
                  <div className="identity-row__id">
                    <div className="identity-row__title">
                      <h3>{name}</h3>
                      {key.invalid || key.revoked ? (
                        <StatusMark tone="idle" label="No longer valid" />
                      ) : (
                        <StatusMark
                          tone="ok"
                          label={expires ? `Expires ${expires}` : "Valid"}
                        />
                      )}
                    </div>
                    <code className="identity-ref">{key.id}</code>
                    <span className="identity-row__when">{keyFacts(key)}</span>
                  </div>
                  {model.canManage ? (
                    <div className="actions">
                      <ArmedKey
                        model={model}
                        arm={{ action: "revoke", id: key.id }}
                        label={`Revoke the auth key ${name}`}
                        confirmLabel={`Confirm revoking the auth key ${name}`}
                        keepLabel={`Keep the auth key ${name}`}
                        onConfirm={() =>
                          void model.run(
                            () => model.admin.deleteKey(key.id),
                            byId(ADD_DEVICE_KEY_ID),
                          )
                        }
                      >
                        <IconTrash size={16} />
                      </ArmedKey>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
