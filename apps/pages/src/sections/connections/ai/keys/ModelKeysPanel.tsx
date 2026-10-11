import { modelApiOf } from "@opensesame/app-core/lib/ai-model-provider.js";
import {
  activeModelKeyBroker,
  notifyModelKeys,
} from "@opensesame/app-core/lib/model-keys/active.js";
/**
 * The keys handed to apps and agents for one saved model provider (ADR 0190).
 *
 * A key stands for the provider's credential without being it: whoever holds
 * one can spend what it was narrowed to, through this device, until it ends or
 * is revoked, and never sees the credential. Keys are in memory, so a lock ends
 * them all. This panel lists them, makes one, and revokes one; it draws nothing
 * where keys cannot exist.
 */
import {
  modelNames,
  requestsLeft,
  timeLeft,
} from "@opensesame/app-core/lib/model-keys/mint-form.js";
import { modelTargetForResource } from "@opensesame/app-core/lib/model-keys/page-ports.js";
import type { KeyView } from "@opensesame/app-core/lib/model-keys/types.js";
import { useState } from "react";
import { IconKey } from "../../../../components/IconKey.js";
import { IconPlus, IconTrash } from "../../../../components/Icons.js";
import { StatusMark } from "../../../../components/StatusMark.js";
import { MintKeySheet } from "./MintKeySheet.js";
import "./model-keys.css";
import { useModelKeys } from "./use-model-keys.js";

const STATUS = {
  active: { tone: "ok", label: "Active" },
  expired: { tone: "idle", label: "Ended" },
  revoked: { tone: "idle", label: "Revoked" },
} as const;

function KeyRow({ view, now }: { view: KeyView; now: number }) {
  const mark = STATUS[view.status];
  const live = view.status === "active";
  return (
    <li
      className={`mkey__row${view.depth > 0 ? " mkey__row--child" : ""}`}
      data-testid="model-key"
    >
      <div className="mkey__copy">
        <h3>{view.clientId}</h3>
        <p>
          {[
            modelNames(view).join(", "),
            requestsLeft(view),
            live ? `ends in ${timeLeft(view.expiresAt, now)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <StatusMark tone={mark.tone} label={mark.label} />
      {live ? (
        <IconKey
          label={`Revoke the key for ${view.clientId}`}
          small
          onClick={() => {
            void activeModelKeyBroker()
              ?.revoke({ id: view.id })
              .then(notifyModelKeys);
          }}
        >
          <IconTrash size={15} />
        </IconKey>
      ) : null}
    </li>
  );
}

/** Where keys can be made: a verified model provider whose every route the catalog lets us inspect. */
export function modelKeyResource(providerId: string): string | null {
  const base = modelApiOf(providerId)?.baseUrl;
  return base && modelTargetForResource(base) ? base : null;
}

export function ModelKeysPanel({
  providerId,
  providerName,
  connectionId,
}: {
  providerId: string;
  providerName: string;
  connectionId: string;
}) {
  const { ready, keys, now } = useModelKeys(connectionId);
  const [open, setOpen] = useState(false);
  const resource = modelKeyResource(providerId);
  if (!ready || resource === null) return null;
  return (
    <section className="panel mkey" id="model-keys" aria-label="Keys">
      <div className="panel__head">
        <h2>Keys</h2>
        <div className="vtree__keys">
          <IconKey label="Create a key" small onClick={() => setOpen(true)}>
            <IconPlus size={15} />
          </IconKey>
        </div>
      </div>
      {keys.length > 0 ? (
        <ul className="conn-list">
          {keys.map((view) => (
            <KeyRow key={view.id} view={view} now={now} />
          ))}
        </ul>
      ) : null}
      {open ? (
        <MintKeySheet
          providerName={providerName}
          connectionId={connectionId}
          resource={resource}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}
