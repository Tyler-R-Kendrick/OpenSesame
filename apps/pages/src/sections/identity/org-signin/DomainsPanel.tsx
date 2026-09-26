/**
 * The email domains that route work addresses to an organization: one row
 * per domain with its state as a glyph, the TXT record to publish while it
 * is unverified, and its keys on the row. Releasing a domain is armed in
 * place — the first press arms it, the second releases, the sibling keeps it.
 */

import { copyTextBestEffort } from "@opensesame/app-core/lib/configuration/clipboard-copy.js";
import type { EmailDomainRow } from "@opensesame/app-core/lib/org-signin.js";
import { type FormEvent, useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconCheck,
  IconCopy,
  IconPlus,
  IconSite,
  IconTrash,
  IconX,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import type { OrgSignInState } from "./use-org-signin.js";

function DomainRow({
  row,
  state,
  online,
  armed,
  onArm,
}: {
  row: EmailDomainRow;
  state: OrgSignInState;
  online: boolean;
  armed: boolean;
  onArm: (domain: string | null) => void;
}) {
  const off = state.busy || !online;
  const verified = row.verifiedAt !== null;
  async function copyRecord() {
    const copied = await copyTextBestEffort(row.txtRecord, navigator.clipboard);
    state.note({
      where: "domains",
      tone: copied.ok ? "ok" : "err",
      label: copied.ok ? `TXT record for ${row.domain} copied` : copied.message,
    });
  }
  return (
    <li className="identity-row">
      <div className="identity-row__main">
        <span className="identity-row__mark">
          <IconSite size={18} />
        </span>
        <div className="identity-row__id">
          <h3>{row.domain}</h3>
          {verified ? null : (
            <code className="identity-ref">{row.txtRecord}</code>
          )}
        </div>
        <StatusMark
          tone={verified ? "ok" : "warn"}
          label={verified ? "Verified" : "Publish the TXT record, then verify"}
        />
        <div className="actions">
          {verified ? null : (
            <>
              <IconKey
                small
                label={`Copy the TXT record for ${row.domain}`}
                onClick={() => void copyRecord()}
              >
                <IconCopy size={16} />
              </IconKey>
              <IconKey
                small
                label={`Verify ${row.domain}`}
                disabled={off}
                onClick={() => void state.verify(row.domain)}
              >
                <IconCheck size={16} />
              </IconKey>
            </>
          )}
          <IconKey
            small
            danger
            armed={armed}
            label={
              armed
                ? `Confirm releasing ${row.domain}`
                : `Release ${row.domain}`
            }
            disabled={off}
            onClick={() =>
              armed
                ? void state.release(row.domain).then(() => onArm(null))
                : onArm(row.domain)
            }
          >
            <IconTrash size={16} />
          </IconKey>
          {armed ? (
            <IconKey
              small
              label={`Keep ${row.domain}`}
              disabled={state.busy}
              onClick={() => onArm(null)}
            >
              <IconX size={16} />
            </IconKey>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function DomainsPanel({
  state,
  online,
}: {
  state: OrgSignInState;
  online: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const mark = state.mark?.where === "domains" ? state.mark : null;
  const rows = state.domains ?? [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await state.claim(draft)) setDraft("");
  }

  return (
    <section className="panel" aria-label="Email domains">
      <div className="panel__head">
        <h2>Email domains</h2>
        {mark ? (
          <div className="actions">
            <StatusMark tone={mark.tone} label={mark.label} />
          </div>
        ) : null}
      </div>
      <div className="panel__body">
        {rows.length > 0 ? (
          <ul className="identity-rows">
            {rows.map((row) => (
              <DomainRow
                key={row.domain}
                row={row}
                state={state}
                online={online}
                armed={armed === row.domain}
                onArm={setArmed}
              />
            ))}
          </ul>
        ) : null}
        <form onSubmit={(event) => void submit(event)}>
          <FieldShell
            id="org-new-domain"
            label="Add a domain"
            mono
            value={draft}
            placeholder="acme.example"
            autoComplete="off"
            disabled={state.busy}
            onValueChange={setDraft}
            tail={
              <button
                type="submit"
                className="icon-btn icon-btn--sm"
                disabled={state.busy || !online || draft.trim() === ""}
                aria-label="Claim this domain"
                title="Claim this domain"
              >
                <IconPlus size={16} />
              </button>
            }
          />
        </form>
      </div>
    </section>
  );
}
