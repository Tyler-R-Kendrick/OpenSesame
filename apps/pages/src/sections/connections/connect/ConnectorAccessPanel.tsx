import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import {
  SHARE_DURATIONS,
  SHARE_POLICIES,
  createLocalShare,
  policyLabel,
  revokeLocalShare,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { type FormEvent, useEffect, useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconShare, IconTrash } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { useLocalShares } from "../../access/LocalSharePanel.js";
import { SelectField } from "./fields.js";

type Identity = { id: string; label: string };

function useIdentities(tomb: string | null): Identity[] {
  const [rows, setRows] = useState<Identity[]>([]);
  useEffect(() => {
    if (!tomb) return;
    let live = true;
    void readLocalDirectory(tomb)
      .then((directory) => {
        if (!live) return;
        setRows(
          directory.entries
            .filter(
              (entry) =>
                (entry.kind === "person" || entry.kind === "agent") &&
                entry.enabled,
            )
            .map((entry) => ({
              id: entry.id,
              label: `${entry.name} · ${entry.kind}`,
            })),
        );
      })
      .catch(() => setRows([]));
    return () => {
      live = false;
    };
  }, [tomb]);
  return rows;
}

const POLICIES = SHARE_POLICIES.connection.map((row) => ({
  id: row.id,
  label: row.label,
}));
const DURATIONS = SHARE_DURATIONS.map((row) => ({
  id: String(row.seconds),
  label: row.label,
}));

function Grants({
  tomb,
  providerId,
  names,
}: { tomb: string; providerId: string; names: Map<string, string> }) {
  const { shares, reload } = useLocalShares(tomb);
  const mine = shares.filter(
    (share) =>
      share.resourceKind === "connection" && share.resourceId === providerId,
  );
  if (mine.length === 0) return null;
  return (
    <ul className="cx-shares">
      {mine.map((share) => (
        <li key={share.id}>
          <span>
            {names.get(share.principalId) ?? share.principalId} ·{" "}
            {policyLabel("connection", share.policy)} ·{" "}
            {new Date(share.expiresAt).toLocaleString()}
          </span>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Revoke access"
            title="Revoke access"
            onClick={() => void revokeLocalShare(tomb, share.id).then(reload)}
          >
            <IconTrash size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Who may use this connector: a person or agent from this vault's directory,
 * under a policy, until a time — the one share ledger Access reads
 * (ADR 0115: a connector binding is a share of kind `connection`).
 */
export function ConnectorAccessPanel({
  providerId,
  label,
}: { providerId: string; label: string }) {
  const { tomb } = useVault();
  const identities = useIdentities(tomb);
  const [principal, setPrincipal] = useState("");
  const [policy, setPolicy] = useState<string>(POLICIES[0]?.id ?? "use");
  const [duration, setDuration] = useState<string>(DURATIONS[0]?.id ?? "3600");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const names = new Map(identities.map((row) => [row.id, row.label]));
  const chosen = principal || identities[0]?.id || "";

  async function grant(event: FormEvent) {
    event.preventDefault();
    if (!tomb || !chosen) return;
    setBusy(true);
    setFailure("");
    try {
      await createLocalShare(tomb, {
        principalId: chosen,
        resourceKind: "connection",
        resourceId: providerId,
        resourceLabel: label,
        policy,
        durationSeconds: Number(duration),
      });
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Could not grant access.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" id="access" aria-label="Access">
      <div className="panel__head">
        <h2>Access</h2>
        {failure ? <StatusMark tone="err" label={failure} /> : null}
      </div>
      <form className="cx-form panel__body" onSubmit={grant}>
        {tomb ? (
          <Grants tomb={tomb} providerId={providerId} names={names} />
        ) : null}
        <div className="cx-grid">
          <SelectField
            label="Identity"
            value={chosen}
            options={
              identities.length
                ? identities
                : [
                    {
                      id: "",
                      label: tomb
                        ? "No people or agents yet"
                        : "Unlock a vault",
                    },
                  ]
            }
            onChange={setPrincipal}
          />
          <SelectField
            label="Policy"
            value={policy}
            options={POLICIES}
            onChange={setPolicy}
          />
          <SelectField
            label="For"
            value={duration}
            options={DURATIONS}
            onChange={setDuration}
          />
        </div>
        <FormCommit
          label="Grant access"
          icon={<IconShare size={18} />}
          busy={busy}
          disabled={busy || !tomb || !chosen}
        />
      </form>
    </section>
  );
}
