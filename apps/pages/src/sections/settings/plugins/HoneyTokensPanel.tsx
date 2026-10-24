/**
 * Self-managed honey tokens inside the surrogate-proxy section. A token is a
 * synthetic proxy key planted beside real secrets; the proxy recognises its
 * reserved prefix and reports a critical tripwire whose subject is the public
 * id. The id, never the secret, is what this panel matches.
 */

import {
  type HoneyTokenRecord,
  honeyTokenStatus,
  issueHoneyToken,
  listHoneyTokens,
  reconcileHoneyTokenNotices,
  resetHoneyToken,
  revokeHoneyToken,
} from "@opensesame/app-core/lib/honey-tokens.js";
import type { PluginNotice } from "@opensesame/app-core/lib/plugins/wire.js";
import { useEffect, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconCopy, IconRefresh, IconTrash } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVaultStore } from "../../../lib/vault/hooks.js";
import "./plugins.css";

function statusOf(token: HoneyTokenRecord): {
  tone: "ok" | "warn" | "idle";
  label: string;
} {
  switch (honeyTokenStatus(token)) {
    case "triggered":
      return { tone: "warn", label: "Triggered" };
    case "revoked":
      return { tone: "idle", label: "Revoked" };
    default:
      return { tone: "ok", label: "Active" };
  }
}

function HoneyTokenRow({
  token,
  onCopy,
  onReset,
  onRevoke,
}: {
  token: HoneyTokenRecord;
  onCopy: () => void;
  onReset: () => void;
  onRevoke: () => void;
}) {
  const status = statusOf(token);
  return (
    <li className="plugin-tile__honey-row">
      <span className="plugin-tile__honey-name">{token.label}</span>
      <StatusMark tone={status.tone} label={status.label} />
      <code className="plugin-tile__honey-token" title={token.token}>
        {token.token}
      </code>
      <IconKey label={`Copy ${token.label}`} small onClick={onCopy}>
        <IconCopy size={15} />
      </IconKey>
      {honeyTokenStatus(token) === "revoked" ? (
        <IconKey label={`Reset ${token.label}`} small onClick={onReset}>
          <IconRefresh size={15} />
        </IconKey>
      ) : (
        <IconKey label={`Revoke ${token.label}`} small onClick={onRevoke}>
          <IconTrash size={15} />
        </IconKey>
      )}
    </li>
  );
}

function HoneyTokenForm({
  label,
  onLabel,
  onIssue,
}: {
  label: string;
  onLabel: (value: string) => void;
  onIssue: () => void;
}) {
  return (
    <div className="plugin-tile__honey-new">
      <label className="field">
        <span>Name</span>
        <input
          value={label}
          maxLength={80}
          placeholder="CI decoy"
          onChange={(event) => onLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onIssue();
            }
          }}
        />
      </label>
      <button
        type="button"
        className="btn btn--sm"
        disabled={label.trim() === ""}
        onClick={onIssue}
      >
        Issue token
      </button>
    </div>
  );
}

function HoneyList({
  rows,
  onCopy,
  onReset,
  onRevoke,
}: {
  rows: readonly HoneyTokenRecord[];
  onCopy: (token: HoneyTokenRecord) => void;
  onReset: (token: HoneyTokenRecord) => void;
  onRevoke: (token: HoneyTokenRecord) => void;
}) {
  if (rows.length === 0)
    return <p className="plugin-tile__honey-empty">No honey tokens issued.</p>;
  return (
    <ul className="plugin-tile__honey-list" aria-label="Issued honey tokens">
      {rows.map((token) => (
        <HoneyTokenRow
          key={token.id}
          token={token}
          onCopy={() => onCopy(token)}
          onReset={() => onReset(token)}
          onRevoke={() => onRevoke(token)}
        />
      ))}
    </ul>
  );
}

export function HoneyTokensPanel({
  notices,
}: { notices: readonly PluginNotice[] }) {
  const store = useVaultStore();
  const scope = store.activeTomb?.() ?? "";
  const [rows, setRows] = useState<HoneyTokenRecord[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scope) {
      setRows([]);
      return;
    }
    let live = true;
    void reconcileHoneyTokenNotices(scope, notices)
      .then((next) => {
        if (live) setRows(next);
      })
      .catch(() => {
        if (live) setError("Could not read the honey-token store.");
      });
    return () => {
      live = false;
    };
  }, [scope, notices]);

  if (!scope) return null;

  const run = (change: () => Promise<HoneyTokenRecord[]>): void => {
    void (async () => {
      try {
        setRows(await change());
        setError(null);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "The change failed.",
        );
        setRows(listHoneyTokens(scope));
      }
    })();
  };

  const issue = (): void => {
    run(async () => {
      const next = await issueHoneyToken(scope, label);
      setLabel("");
      const rows = listHoneyTokens(scope);
      return rows.some((row) => row.id === next.id) ? rows : [...rows, next];
    });
  };

  const copy = async (token: HoneyTokenRecord): Promise<void> => {
    try {
      await navigator.clipboard.writeText(token.token);
      setError(null);
    } catch {
      setError("Copy the token from the field instead.");
    }
  };

  return (
    <section
      className="plugin-tile__honey"
      aria-labelledby="honey-tokens-title"
    >
      <div className="plugin-tile__honey-head">
        <h3 id="honey-tokens-title">Honey tokens</h3>
        <p>
          Plant these synthetic proxy keys beside real secrets. Any use through
          the surrogate proxy raises a critical tripwire.
        </p>
      </div>
      <HoneyTokenForm label={label} onLabel={setLabel} onIssue={issue} />
      {error ? (
        <p className="plugin-tile__honey-error" role="alert">
          {error}
        </p>
      ) : null}
      <HoneyList
        rows={rows}
        onCopy={(token) => void copy(token)}
        onReset={(token) =>
          run(async () => {
            await resetHoneyToken(scope, token.id);
            return listHoneyTokens(scope);
          })
        }
        onRevoke={(token) =>
          run(async () => {
            await revokeHoneyToken(scope, token.id);
            return listHoneyTokens(scope);
          })
        }
      />
    </section>
  );
}
