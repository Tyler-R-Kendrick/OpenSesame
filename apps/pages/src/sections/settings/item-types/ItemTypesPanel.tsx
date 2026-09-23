/**
 * Settings › Vaults › Item types (ADR 0087 §7, ADR 0134).
 *
 * A view over files. `settings/item-types/installed/*.json` is what this
 * vault has installed, `builtin/` what the build ships, and
 * `marketplaces.json` which repositories to read; Installed and Marketplace
 * are drawn from them, and every key here is a write to one of them through
 * the same provider Settings' file viewer uses. So an install from a
 * marketplace and a file saved by hand meet the same parser and the same
 * registry rules, and each row opens the file it is. The outcome of an
 * action is a glyph in the head and a sentence for assistive technology.
 */

import { installedPath } from "@opensesame/app-core/sections/settings/item-type-files.js";
import type { VirtualFileProvider } from "@opensesame/app-core/sections/settings/virtual-files.js";
import { itemTypeRegistry } from "@opensesame/vault-core";
import { parseDefinition } from "@opensesame/vault-item-types";
import { type KeyboardEvent, useRef, useState } from "react";
import { StatusMark } from "../../../components/StatusMark.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import { useItemTypeFiles } from "../files/providers.js";
import { InstalledTypes } from "./InstalledTypes.js";
import { MarketplaceOffers } from "./MarketplaceOffers.js";
import { MarketplaceSources } from "./MarketplaceSources.js";
import { useMarketplaces } from "./useMarketplaces.js";
import "./item-types.css";

const TABS = [
  { id: "installed", label: "Installed" },
  { id: "marketplace", label: "Marketplace" },
] as const;

type TabId = (typeof TABS)[number]["id"];

type Outcome = { tone: "ok" | "err"; text: string } | null;

function Tabs({
  selected,
  onSelect,
}: {
  selected: TabId;
  onSelect: (tab: TabId) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, at: number) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const edge =
      event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
    if (step === 0 && edge === null) return;
    event.preventDefault();
    const next = edge ?? (at + step + TABS.length) % TABS.length;
    const tab = TABS[next];
    if (!tab) return;
    onSelect(tab.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="itype-tabs" role="tablist" aria-label="Item type views">
      {TABS.map((tab, at) => (
        <button
          key={tab.id}
          ref={(node) => {
            refs.current[at] = node;
          }}
          type="button"
          role="tab"
          id={`itype-tab-${tab.id}`}
          aria-controls={`itype-panel-${tab.id}`}
          aria-selected={selected === tab.id}
          tabIndex={selected === tab.id ? 0 : -1}
          className={`itype-tab${selected === tab.id ? " is-active" : ""}`}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => move(event, at)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function useFileActions(files: VirtualFileProvider) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const run = (task: () => Promise<string>) => {
    setBusy(true);
    setOutcome(null);
    void task()
      .then((text) => setOutcome({ tone: "ok", text }))
      .catch((caught: unknown) =>
        setOutcome({
          tone: "err",
          text: caught instanceof Error ? caught.message : "It did not save.",
        }),
      )
      .finally(() => setBusy(false));
  };
  /** Installing is writing `installed/<id>.json`. */
  const install = (text: string) =>
    run(async () => {
      const parsed = parseDefinition(text, "community");
      if (!parsed.ok) throw new Error("That definition does not parse.");
      const { id } = parsed.definition.metadata;
      const written = await files.write(installedPath(id), text);
      if (!written.ok) throw new Error(written.message);
      return `${parsed.definition.spec.title} installed as ${id}.json.`;
    });
  /** Removing is deleting it. Items of that type keep their values. */
  const remove = (id: string) =>
    run(async () => {
      const title = itemTypeRegistry().get(id)?.spec.title ?? id;
      const removed = await files.remove(installedPath(id));
      if (!removed.ok) throw new Error(removed.message);
      return `${title} removed. Its items keep their values.`;
    });
  return { busy, outcome, install, remove };
}

export function ItemTypesPanel() {
  const files = useItemTypeFiles();
  const guide = useGuideTarget<HTMLElement>("settings.item-types");
  const [tab, setTab] = useState<TabId>("installed");
  const market = useMarketplaces(tab === "marketplace", files);
  const { busy, outcome, install, remove } = useFileActions(files);
  const all = itemTypeRegistry().list();
  const builtins = all.filter(({ source }) => source === "builtin").length;

  return (
    <section ref={guide} className="panel itype-panel" id="item-types">
      <div className="panel__head">
        <h2>Item types</h2>
        <span className="itype-head__end">
          <span className="itype-count">
            {builtins} built in · {all.length - builtins} installed
          </span>
          {outcome ? (
            <StatusMark tone={outcome.tone} label={outcome.text} />
          ) : null}
        </span>
      </div>
      <output className="visually-hidden" aria-live="polite">
        {outcome?.text ?? ""}
      </output>
      <div className="panel__body">
        <Tabs selected={tab} onSelect={setTab} />
        <div
          role="tabpanel"
          id={`itype-panel-${tab}`}
          aria-labelledby={`itype-tab-${tab}`}
          className="itype-tabpanel"
        >
          {tab === "installed" ? (
            <InstalledTypes
              files={files}
              busy={busy}
              onRemove={remove}
              onBrowse={() => setTab("marketplace")}
            />
          ) : null}
          {tab === "marketplace" ? (
            <>
              <MarketplaceSources market={market} />
              <MarketplaceOffers
                market={market}
                busy={busy}
                onInstall={(offer) => install(offer.text)}
              />
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
