/**
 * Import a set of connectors onto the Connections page (ADR 0115, ADR 0147).
 *
 * Two sources, each read by reference — never a provider token:
 *
 *  - a **Nango-compatible directory**: its endpoint and an environment key;
 *    what it lists is sealed in this vault and shown under Connected;
 *  - **Vercel Connect**: the team's credential, sealed in this vault; every
 *    connector configured there joins Connected.
 *
 * Who may use an imported connector is decided on Access › Connectors.
 */

import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type KeyboardEvent, useState } from "react";
import { ConnectorDirectoryForm } from "../../components/ConnectorDirectoryForm.js";
import { IconDownload, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { ConnectorMark } from "./ConnectorMark.js";
import { ConnectTransportForm } from "./connect/ConnectTransportForm.js";
import { useConnectTransport } from "./connect/useConnectTransport.js";

type Source = "directory" | "vercel";

const SOURCES: readonly {
  id: Source;
  name: string;
  kind: string;
  mark: string;
}[] = [
  { id: "directory", name: "Nango", kind: "Directory", mark: "nango" },
  { id: "vercel", name: "Vercel Connect", kind: "Team", mark: "vercel" },
];

/** The key in Connected's head: Import, or Close while the sources are open. */
export function ImportKey({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const label = open ? "Close import" : "Import connectors";
  return (
    <button
      id="connectors-import"
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label={label}
      title={label}
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? <IconX size={16} /> : <IconDownload size={16} />}
    </button>
  );
}

export function ConnectorImport({
  tomb,
  onFlash,
  onImported,
  onClose,
}: {
  tomb: string;
  onFlash: (flash: Flash) => void;
  /** After a source imported: the page reads its connectors again. */
  onImported: () => void;
  onClose: () => void;
}) {
  const transport = useConnectTransport();
  const [source, setSource] = useState<Source | null>(null);
  function onKeyDown(event: KeyboardEvent<HTMLFieldSetElement>) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  }
  return (
    <fieldset
      className="conn-import"
      aria-label="Import connectors"
      onKeyDown={onKeyDown}
    >
      <ul className="conn-grid" aria-label="Import from">
        {SOURCES.map((entry) => (
          <li className="conn-tile" key={entry.id}>
            <button
              type="button"
              className="conn-tile__link conn-import__choice"
              aria-pressed={source === entry.id}
              onClick={() => setSource(source === entry.id ? null : entry.id)}
            >
              <ConnectorMark
                providerId={entry.mark}
                displayName={entry.name}
                size={32}
              />
              <span className="conn-tile__copy">
                <span className="conn-tile__name">{entry.name}</span>
                <span className="conn-tile__kind">{entry.kind}</span>
              </span>
              {entry.id === "vercel" && transport.canManage ? (
                <StatusMark tone="ok" label="Imported" />
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {source === "directory" ? (
        <ConnectorDirectoryForm
          tomb={tomb || null}
          terse
          onSynced={() => onImported()}
        />
      ) : null}
      {source === "vercel" ? (
        transport.canManage ? (
          <StatusMark
            tone="ok"
            label="Vercel Connect is ready on this device."
          />
        ) : (
          <ConnectTransportForm
            relay={transport.relay}
            onFlash={onFlash}
            onSealed={onImported}
          />
        )
      ) : null}
    </fieldset>
  );
}
