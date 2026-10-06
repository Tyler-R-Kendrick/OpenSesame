/**
 * Settings › Vaults › Item types (ADR 0087 §7, ADR 0134, ADR 0165).
 *
 * A list of switches. Each built-in type beyond the secret and the file is
 * one row; switching it on downloads and installs it — nothing of it is in
 * the app until then — and the row shows where it is on the way. Types a
 * person wrote or took from a marketplace sit beneath, as files (ADR 0134),
 * and the marketplaces are one key away. The outcome of an action is a glyph
 * in the head and a sentence for assistive technology.
 */

import {
  packGroups,
  packTally,
} from "@opensesame/app-core/sections/settings/item-type-packs-model.js";
import { itemTypeRegistry } from "@opensesame/vault-core";
import { useState } from "react";
import { useContributions } from "../../../bindings/contributions.js";
import { usePackSnapshot } from "../../../bindings/type-packs.js";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconChevronLeft, IconGitBranch } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import { useItemTypeFiles } from "../files/providers.js";
import { InstalledTypes } from "./InstalledTypes.js";
import { MarketplaceOffers } from "./MarketplaceOffers.js";
import { MarketplaceSources } from "./MarketplaceSources.js";
import { PackList } from "./PackList.js";
import { useFileActions } from "./useFileActions.js";
import { useMarketplaces } from "./useMarketplaces.js";
import { usePackActions } from "./usePackActions.js";
import "./item-types.css";

type View = "types" | "marketplace";

export function ItemTypesPanel() {
  const files = useItemTypeFiles();
  // The head, not the panel: the lit control has to be small enough for the
  // tutorial card to sit beside it (ADR 0163), and the list below is long.
  const guide = useGuideTarget<HTMLDivElement>("settings.item-types");
  const [view, setView] = useState<View>("types");
  const [query, setQuery] = useState("");
  const snapshot = usePackSnapshot();
  const packs = usePackActions(snapshot);
  const market = useMarketplaces(view === "marketplace", files);
  const { busy, outcome: fileOutcome, install, remove } = useFileActions(files);
  const outcome = packs.outcome ?? fileOutcome;
  // Built-ins a capability contributes: their switch is the capability's.
  const managed = new Set(
    useContributions("item-kind").map((entry) => entry.kind),
  );
  const groups = packGroups(snapshot, { query, managed });
  // Types a person wrote or took from a marketplace, beside the built-ins.
  const community = itemTypeRegistry()
    .list()
    .filter(({ source }) => source !== "builtin").length;

  return (
    <section className="panel itype-panel" id="item-types">
      <div ref={guide} className="panel__head">
        <h2>Item types</h2>
        <span className="itype-head__end">
          <span className="itype-count">{packTally(snapshot)}</span>
          {snapshot.pending > 0 ? (
            <span
              className="pack__spin"
              role="img"
              aria-label={`Installing ${snapshot.pending} item ${snapshot.pending === 1 ? "type" : "types"}`}
              title={`Installing ${snapshot.pending} item ${snapshot.pending === 1 ? "type" : "types"}`}
            />
          ) : null}
          {outcome ? (
            <StatusMark tone={outcome.tone} label={outcome.text} />
          ) : null}
          {view === "types" ? (
            <IconKey
              small
              label="Find more item types"
              onClick={() => setView("marketplace")}
            >
              <IconGitBranch size={16} />
            </IconKey>
          ) : (
            <IconKey
              small
              label="Back to item types"
              onClick={() => setView("types")}
            >
              <IconChevronLeft size={16} />
            </IconKey>
          )}
        </span>
      </div>
      <FailureNotice
        id="settings:item-types:outcome"
        title="Item types"
        message={outcome?.tone === "err" ? outcome.text : null}
      />
      <output className="visually-hidden" aria-live="polite">
        {outcome?.tone === "ok" ? outcome.text : packs.said}
      </output>
      <div className="panel__body">
        {view === "types" ? (
          <div className="itype-tabpanel">
            <PackList
              groups={groups}
              query={query}
              onQuery={setQuery}
              onToggle={packs.toggle}
            />
            {community > 0 || query === "" ? (
              <InstalledTypes files={files} busy={busy} onRemove={remove} />
            ) : null}
          </div>
        ) : (
          <div className="itype-tabpanel">
            <MarketplaceSources market={market} />
            <MarketplaceOffers
              market={market}
              busy={busy}
              onInstall={(offer) => install(offer.text)}
            />
          </div>
        )}
      </div>
    </section>
  );
}
