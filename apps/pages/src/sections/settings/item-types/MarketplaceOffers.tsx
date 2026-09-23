/**
 * What the listed marketplaces offer, one group per marketplace. Each row
 * says where the type stands on this device and carries one action: install
 * what is not here, update what is behind. Inspect opens the fields first,
 * because installing a type defines the form a person will later fill in —
 * they should see it before it is theirs (ADR 0087, capability registry:
 * installing is a human ceremony).
 */

import type { MarketplaceOffer } from "@opensesame/app-core/lib/item-type-marketplace/load.js";
import {
  parseMarketplaceSource,
  sourceLabel,
} from "@opensesame/app-core/lib/item-type-marketplace/source.js";
import {
  type OfferState,
  offerRank,
  offerState,
  offerStateLabel,
} from "@opensesame/app-core/sections/settings/item-type-marketplace-model.js";
import { itemTypeRegistry } from "@opensesame/vault-core";
import { definitionFields } from "@opensesame/vault-item-types";
import { useState } from "react";
import {
  IconDownload,
  IconEye,
  IconEyeOff,
  IconRefresh,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { FieldList, TypeRow } from "./TypeRow.js";
import type { useMarketplaces } from "./useMarketplaces.js";

type Marketplaces = ReturnType<typeof useMarketplaces>;
type Ready = Extract<MarketplaceOffer, { ok: true }>;

function tone(state: OfferState) {
  if (state.kind === "installed") return "ok" as const;
  if (state.kind === "update" || state.kind === "conflict")
    return "warn" as const;
  if (state.kind === "invalid") return "err" as const;
  return "idle" as const;
}

function Action({
  offer,
  state,
  busy,
  onInstall,
}: {
  offer: Ready;
  state: OfferState;
  busy: boolean;
  onInstall: (offer: Ready) => void;
}) {
  const title = offer.definition.spec.title;
  if (state.kind === "available" || state.kind === "update") {
    const verb =
      state.kind === "update"
        ? `Update ${title} to ${offer.definition.metadata.version}`
        : `Install ${title}`;
    return (
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        disabled={busy}
        aria-label={verb}
        title={verb}
        onClick={() => onInstall(offer)}
      >
        {state.kind === "update" ? (
          <IconRefresh size={16} />
        ) : (
          <IconDownload size={16} />
        )}
      </button>
    );
  }
  return null;
}

function OfferRow({
  offer,
  busy,
  onInstall,
}: {
  offer: Ready;
  busy: boolean;
  onInstall: (offer: Ready) => void;
}) {
  const [open, setOpen] = useState(false);
  const state = offerState(itemTypeRegistry(), offer);
  const title = offer.definition.spec.title;
  const inspect = open ? `Hide ${title}'s fields` : `Inspect ${title}'s fields`;
  const fields = definitionFields(offer.definition).map((field) => ({
    id: field.id,
    label: field.label,
    type: field.type,
  }));
  return (
    <TypeRow
      definition={offer.definition}
      summary
      trailing={
        <>
          {state.kind === "available" ? null : (
            <StatusMark tone={tone(state)} label={offerStateLabel(state)} />
          )}
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-expanded={open}
            aria-label={inspect}
            title={inspect}
            onClick={() => setOpen(!open)}
          >
            {open ? <IconEyeOff size={16} /> : <IconEye size={16} />}
          </button>
          <Action
            offer={offer}
            state={state}
            busy={busy}
            onInstall={onInstall}
          />
        </>
      }
    >
      {open ? <FieldList fields={fields} label={`${title} fields`} /> : null}
    </TypeRow>
  );
}

function Refused({
  offer,
}: { offer: Extract<MarketplaceOffer, { ok: false }> }) {
  return (
    <li className="itype">
      <div className="itype__row">
        <span className="itype__ext">—</span>
        <span className="itype__text">
          <span className="itype__name itype__name--mono">{offer.path}</span>
          <span className="itype__meta">cannot be installed</span>
        </span>
        <span className="itype__end">
          <StatusMark tone="err" label={offer.problem} />
        </span>
      </div>
    </li>
  );
}

function ranked(offers: readonly MarketplaceOffer[]) {
  const registry = itemTypeRegistry();
  return [...offers].sort((a, b) => {
    const rank =
      offerRank(offerState(registry, a)) - offerRank(offerState(registry, b));
    if (rank !== 0 || !a.ok || !b.ok) return rank;
    return a.definition.spec.title.localeCompare(b.definition.spec.title);
  });
}

export function MarketplaceOffers({
  market,
  busy,
  onInstall,
}: {
  market: Marketplaces;
  busy: boolean;
  onInstall: (offer: Ready) => void;
}) {
  const groups = market.sources.flatMap((reference) => {
    const state = market.stateOf(reference);
    const source = parseMarketplaceSource(reference);
    if (state.status !== "ok" || source === null) return [];
    return [{ reference, label: sourceLabel(source), listing: state.listing }];
  });
  if (groups.length === 0) return null;
  return (
    <>
      {groups.map(({ reference, label, listing }) => (
        <section
          key={reference}
          className="itype-offers"
          aria-label={`${listing.name} — ${label}`}
        >
          <h3 className="itype-offers__head">
            <span>{listing.name}</span>
            <span className="itype-count">{listing.offers.length}</span>
          </h3>
          {listing.offers.length === 0 ? (
            <p className="itype-empty">This marketplace lists no item types.</p>
          ) : (
            <ul
              className="itype-list"
              aria-label={`Offered by ${listing.name}`}
            >
              {ranked(listing.offers).map((offer) =>
                offer.ok ? (
                  <OfferRow
                    key={offer.path}
                    offer={offer}
                    busy={busy}
                    onInstall={onInstall}
                  />
                ) : (
                  <Refused key={offer.path} offer={offer} />
                ),
              )}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}
