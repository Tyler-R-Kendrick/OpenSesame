/**
 * The Marketplace view's state, drawn from `settings/item-types/
 * marketplaces.json` (ADR 0134). The file says which repositories to read;
 * adding or removing one here is an edit to that file, written through its
 * provider, so the file viewer and this view never disagree.
 *
 * A read starts only when a person opens the Marketplace tab or presses a
 * source's reload key — never on page load, never in the background. What a
 * repository offered is kept for the tab's life, so moving between tabs does
 * not read a repository twice.
 */

import {
  type MarketplaceListing,
  loadMarketplace,
} from "@opensesame/app-core/lib/item-type-marketplace/load.js";
import {
  DEFAULT_MARKETPLACES_FILE,
  type MarketplacesEdit,
  parseMarketplacesFile,
  withDefaultMarketplace,
  withMarketplace,
  withoutMarketplace,
} from "@opensesame/app-core/lib/item-type-marketplace/marketplaces-file.js";
import { parseMarketplaceSource } from "@opensesame/app-core/lib/item-type-marketplace/source.js";
import { MARKETPLACES_PATH } from "@opensesame/app-core/sections/settings/item-type-files.js";
import type { VirtualFileProvider } from "@opensesame/app-core/sections/settings/virtual-files.js";
import { useCallback, useEffect, useState } from "react";
import { useSettingsFilesRevision } from "../files/revision.js";

export type ListingState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly listing: MarketplaceListing }
  | { readonly status: "err"; readonly message: string };

export type EditOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export const marketplaceDependencies = { loadMarketplace };

/** Session cache: a listing outlives the component, not the tab. */
const listings = new Map<string, ListingState>();

export function forgetMarketplaceListings(): void {
  listings.clear();
}

type FileRead = {
  /** The write this read answers; a newer one re-reads. */
  readonly revision: number;
  readonly text: string | null;
  readonly unreadable: boolean;
};

function useMarketplacesFile(files: VirtualFileProvider): FileRead {
  // Re-read whenever any settings file is written, from either view.
  const revision = useSettingsFilesRevision();
  const [read, setRead] = useState<FileRead>({
    revision: -1,
    text: null,
    unreadable: false,
  });
  useEffect(() => {
    let live = true;
    void files.read(MARKETPLACES_PATH).then(
      (text) => {
        if (live) setRead({ revision, text, unreadable: false });
      },
      () => {
        if (live) setRead({ revision, text: null, unreadable: true });
      },
    );
    return () => {
      live = false;
    };
  }, [files, revision]);
  return read;
}

export function useMarketplaces(active: boolean, files: VirtualFileProvider) {
  const { text, unreadable } = useMarketplacesFile(files);
  const parsed = text === null ? null : parseMarketplacesFile(text);
  const sources = parsed?.ok ? parsed.sources : [];
  const [, setTick] = useState(0);
  const redraw = useCallback(() => setTick((tick) => tick + 1), []);

  const load = useCallback(
    (reference: string) => {
      const source = parseMarketplaceSource(reference);
      if (source === null) return;
      listings.set(reference, { status: "loading" });
      redraw();
      void marketplaceDependencies
        .loadMarketplace(source)
        .then((listing) => listings.set(reference, { status: "ok", listing }))
        .catch((caught: unknown) =>
          listings.set(reference, {
            status: "err",
            message:
              caught instanceof Error ? caught.message : "Could not read it.",
          }),
        )
        .finally(redraw);
    },
    [redraw],
  );

  const joined = sources.join("\n");
  useEffect(() => {
    if (!active) return;
    for (const reference of joined === "" ? [] : joined.split("\n")) {
      if ((listings.get(reference)?.status ?? "idle") === "idle")
        load(reference);
    }
  }, [active, joined, load]);

  const edit = async (next: MarketplacesEdit): Promise<EditOutcome> => {
    if (!next.ok) return next;
    const written = await files.write(MARKETPLACES_PATH, next.text);
    return written.ok ? { ok: true } : written;
  };
  const current = text ?? DEFAULT_MARKETPLACES_FILE;

  return {
    sources,
    /** The file does not parse: the view shows nothing it cannot stand on. */
    fileProblem: unreadable
      ? "marketplaces.json could not be opened with this vault's key."
      : parsed && !parsed.ok
        ? parsed.message
        : null,
    stateOf: (reference: string): ListingState =>
      listings.get(reference) ?? { status: "idle" },
    load,
    add: (raw: string) => edit(withMarketplace(current, raw)),
    remove: (reference: string) => {
      listings.delete(reference);
      return edit(withoutMarketplace(current, reference));
    },
    restore: () => edit(withDefaultMarketplace(current)),
  };
}
