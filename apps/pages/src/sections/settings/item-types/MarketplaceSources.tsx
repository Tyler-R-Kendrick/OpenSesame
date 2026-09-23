/**
 * The repositories this vault reads item types from (ADR 0134), as
 * `settings/item-types/marketplaces.json` lists them: one row each, with
 * what the last read found, a field that adds a line to the file, and a key
 * that opens the file itself. Ours is listed until someone removes it, and
 * one key puts it back.
 */

import { isDefaultMarketplace } from "@opensesame/app-core/lib/item-type-marketplace/marketplaces-file.js";
import {
  parseMarketplaceSource,
  sourceLabel,
  sourceWebUrl,
} from "@opensesame/app-core/lib/item-type-marketplace/source.js";
import { MARKETPLACES_PATH } from "@opensesame/app-core/sections/settings/item-type-files.js";
import { useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import {
  IconExternal,
  IconGitBranch,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { OpenFileKey } from "../files/OpenFileKey.js";
import type { ListingState, useMarketplaces } from "./useMarketplaces.js";

type Marketplaces = ReturnType<typeof useMarketplaces>;

function stateMark(state: ListingState) {
  switch (state.status) {
    case "ok": {
      const count = state.listing.offers.length;
      return (
        <StatusMark
          tone="ok"
          label={`Read: ${count} ${count === 1 ? "type" : "types"}`}
        />
      );
    }
    case "err":
      return <StatusMark tone="err" label={state.message} />;
    case "loading":
      return <StatusMark tone="idle" label="Reading" />;
    default:
      return <StatusMark tone="idle" label="Not read yet" />;
  }
}

function sourceMeta(reference: string, state: ListingState): string {
  const ours = isDefaultMarketplace(reference) ? "default · " : "";
  if (state.status === "ok") {
    const count = state.listing.offers.length;
    return `${ours}${state.listing.name} · ${count} ${count === 1 ? "type" : "types"}`;
  }
  if (state.status === "err") return `${ours}${state.message}`;
  if (state.status === "loading") return `${ours}reading…`;
  return `${ours}not read yet`;
}

type Report = (outcome: { ok: true } | { ok: false; message: string }) => void;

function SourceRow({
  reference,
  market,
  report,
}: {
  reference: string;
  market: Marketplaces;
  report: Report;
}) {
  const source = parseMarketplaceSource(reference);
  if (source === null) return null;
  const label = sourceLabel(source);
  const state = market.stateOf(reference);
  return (
    <li className="itype-source" aria-busy={state.status === "loading"}>
      <span className="itype-source__mark" aria-hidden="true">
        <IconGitBranch size={16} />
      </span>
      <span className="itype__text">
        <span className="itype__name itype__name--mono">{label}</span>
        <span className="itype__meta">{sourceMeta(reference, state)}</span>
      </span>
      <span className="itype__end">
        {stateMark(state)}
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={state.status === "loading"}
          aria-label={`Read ${label} again`}
          title="Read again"
          onClick={() => market.load(reference)}
        >
          <IconRefresh size={16} />
        </button>
        <a
          className="icon-btn icon-btn--sm"
          href={sourceWebUrl(source)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${label} in a new tab`}
          title="Open the repository"
        >
          <IconExternal size={16} />
        </a>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Stop reading ${label}`}
          title="Remove this marketplace"
          onClick={() => void market.remove(reference).then(report)}
        >
          <IconTrash size={16} />
        </button>
      </span>
    </li>
  );
}

function AddSource({ market }: { market: Marketplaces }) {
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const submit = () => {
    void market.add(draft).then((outcome) => {
      if (outcome.ok) {
        setDraft("");
        setRefusal(null);
      } else setRefusal(outcome.message);
    });
  };
  return (
    <form
      className="itype-add"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <FieldShell
        id="item-type-marketplace"
        label="Add a marketplace"
        mono
        lead={<IconGitBranch size={17} />}
        placeholder="owner/repo or a git URL"
        value={draft}
        status={refusal ? <StatusMark tone="err" label={refusal} /> : undefined}
        onValueChange={(next) => {
          setDraft(next);
          setRefusal(null);
        }}
        tail={
          <button
            type="submit"
            className="icon-btn"
            disabled={!market.ready || draft.trim() === ""}
            aria-label="Add marketplace"
            title="Add marketplace"
          >
            <IconPlus size={16} />
          </button>
        }
      />
    </form>
  );
}

export function MarketplaceSources({ market }: { market: Marketplaces }) {
  const hasDefault = market.sources.some(isDefaultMarketplace);
  const [refusal, setRefusal] = useState<string | null>(null);
  const report: Report = (outcome) =>
    setRefusal(outcome.ok ? null : outcome.message);
  const problem = market.fileProblem ?? refusal;
  return (
    <div className="itype-sources">
      <div className="itype-sources__file">
        <code>marketplaces.json</code>
        {problem ? <StatusMark tone="err" label={problem} /> : null}
        <OpenFileKey path={MARKETPLACES_PATH} name="marketplaces.json" />
      </div>
      {market.sources.length > 0 ? (
        <ul className="itype-list" aria-label="Marketplaces">
          {market.sources.map((reference) => (
            <SourceRow
              key={reference}
              reference={reference}
              market={market}
              report={report}
            />
          ))}
        </ul>
      ) : market.ready ? (
        <p className="itype-empty">No marketplaces listed.</p>
      ) : null}
      <div className="itype-sources__foot">
        <AddSource market={market} />
        {hasDefault ? null : (
          <button
            type="button"
            className="icon-btn"
            aria-label="List the OpenSesame marketplace again"
            title="Restore the default marketplace"
            onClick={() => void market.restore().then(report)}
          >
            <IconRefresh size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
