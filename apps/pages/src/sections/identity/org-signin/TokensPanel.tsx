/**
 * An organization's SCIM provisioning tokens. The list carries ids and
 * dates; a token's plaintext exists here once, in the block the mint key
 * opens, and nowhere else (`use-org-signin.ts`). Revoking is armed in place.
 */

import { copyTextBestEffort } from "@opensesame/app-core/lib/configuration/clipboard-copy.js";
import type {
  MintedScimToken,
  ScimTokenRow,
} from "@opensesame/app-core/lib/org-signin.js";
import { useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconCopy,
  IconPlus,
  IconSecret,
  IconTrash,
  IconX,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useCopySecret } from "../../../lib/vault/hooks.js";
import type { OrgSignInState } from "./use-org-signin.js";

function day(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The plaintext, once: a copy key, and a key that hides it for good. */
function Minted({
  minted,
  state,
}: {
  minted: MintedScimToken;
  state: OrgSignInState;
}) {
  const copySecret = useCopySecret();
  async function copyToken() {
    const done = await copySecret(minted.token);
    state.note({
      where: "tokens",
      tone: done === "copied" ? "ok" : "err",
      label:
        done === "copied" ? "Token copied" : "The clipboard is not available",
    });
  }
  async function copyBase(base: string) {
    const copied = await copyTextBestEffort(base, navigator.clipboard);
    state.note({
      where: "tokens",
      tone: copied.ok ? "ok" : "err",
      label: copied.ok ? "SCIM base URL copied" : copied.message,
    });
  }
  return (
    <div className="org-signin__minted">
      <FieldShell
        id="org-scim-minted"
        label={`Token ${minted.id}`}
        mono
        readOnly
        value={minted.token}
        status={<StatusMark tone="warn" label="Shown once: copy it now" />}
        tail={
          <>
            <IconKey
              small
              label="Copy the token"
              onClick={() => void copyToken()}
            >
              <IconCopy size={16} />
            </IconKey>
            <IconKey small label="Hide the token" onClick={state.dismiss}>
              <IconX size={16} />
            </IconKey>
          </>
        }
      />
      {minted.scimBaseUrl ? (
        <FieldShell
          id="org-scim-base"
          label="SCIM base URL"
          mono
          readOnly
          value={minted.scimBaseUrl}
          tail={
            <IconKey
              small
              label="Copy the SCIM base URL"
              onClick={() => void copyBase(minted.scimBaseUrl ?? "")}
            >
              <IconCopy size={16} />
            </IconKey>
          }
        />
      ) : null}
    </div>
  );
}

function TokenRow({
  row,
  state,
  online,
  armed,
  onArm,
}: {
  row: ScimTokenRow;
  state: OrgSignInState;
  online: boolean;
  armed: boolean;
  onArm: (id: string | null) => void;
}) {
  const when = day(row.createdAt);
  return (
    <li className="identity-row">
      <div className="identity-row__main">
        <span className="identity-row__mark">
          <IconSecret size={18} />
        </span>
        <div className="identity-row__id">
          <code className="identity-ref">{row.id}</code>
          {when ? <span className="identity-row__when">{when}</span> : null}
        </div>
        <StatusMark
          tone={row.revoked ? "idle" : "ok"}
          label={row.revoked ? "Revoked" : "Active"}
        />
        {row.revoked ? null : (
          <div className="actions">
            <IconKey
              small
              danger
              armed={armed}
              label={armed ? `Confirm revoking ${row.id}` : `Revoke ${row.id}`}
              disabled={state.busy || !online}
              onClick={() =>
                armed
                  ? void state.revoke(row.id).then(() => onArm(null))
                  : onArm(row.id)
              }
            >
              <IconTrash size={16} />
            </IconKey>
            {armed ? (
              <IconKey
                small
                label={`Keep ${row.id}`}
                disabled={state.busy}
                onClick={() => onArm(null)}
              >
                <IconX size={16} />
              </IconKey>
            ) : null}
          </div>
        )}
      </div>
    </li>
  );
}

export function TokensPanel({
  state,
  online,
}: {
  state: OrgSignInState;
  online: boolean;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  const mark = state.mark?.where === "tokens" ? state.mark : null;
  const rows = state.tokens ?? [];
  return (
    <section className="panel" aria-label="Provisioning tokens">
      <div className="panel__head">
        <h2>Provisioning tokens</h2>
        <div className="actions">
          {mark ? <StatusMark tone={mark.tone} label={mark.label} /> : null}
          <IconKey
            small
            label="Mint a provisioning token"
            disabled={state.busy || !online}
            onClick={() => void state.mint()}
          >
            <IconPlus size={16} />
          </IconKey>
        </div>
      </div>
      <div className="panel__body">
        {state.minted ? <Minted minted={state.minted} state={state} /> : null}
        {rows.length > 0 ? (
          <ul className="identity-rows">
            {rows.map((row) => (
              <TokenRow
                key={row.id}
                row={row}
                state={state}
                online={online}
                armed={armed === row.id}
                onArm={setArmed}
              />
            ))}
          </ul>
        ) : state.tokens ? (
          <p className="hint">No provisioning tokens.</p>
        ) : null}
      </div>
    </section>
  );
}
