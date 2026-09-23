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
  /** The provider that read it: a different vault's provider is not it. */
  readonly files: VirtualFileProvider | null;
  /** The write this read answers; a newer one re-reads. */
  readonly revision: number;
  readonly text: string | null;
  readonly unreadable: boolean;
};

/**
 * The file as last read, or null while a read for this vault and this
 * revision is still outstanding. Nothing is shown — or edited — from a read
 * that belongs to another vault or to the file before its latest write.
 */
function useMarketplacesFile(files: VirtualFileProvider) {
  // Re-read whenever any settings file is written, from either view.
  const revision = useSettingsFilesRevision();
  const [read, setRead] = useState<FileRead>({
    files: null,
    revision: -1,
    text: null,
    unreadable: false,
  });
  useEffect(() => {
    let live = true;
    void files.read(MARKETPLACES_PATH).then(
      (text) => {
        if (live) setRead({ files, revision, text, unreadable: false });
      },
      () => {
        if (live) setRead({ files, revision, text: null, unreadable: true });
      },
    );
    return () => {
      live = false;
    };
  }, [files, revision]);
  const fresh = read.files === files && read.revision === revision;
  return {
    text: fresh ? read.text : null,
    unreadable: fresh && read.unreadable,
  };
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

  const unreadMessage = unreadable
    ? "marketplaces.json could not be opened with this vault's key."
    : "marketplaces.json is still being read.";
  /**
   * Every edit is made to the file as it was just read. Until that read is
   * in, there is nothing to edit — writing an edit of a default instead
   * would drop every repository the stored file lists.
   */
  const edit = async (
    change: (current: string) => MarketplacesEdit,
  ): Promise<EditOutcome> => {
    if (text === null) return { ok: false, message: unreadMessage };
    const next = change(text);
    if (!next.ok) return next;
    const written = await files.write(MARKETPLACES_PATH, next.text);
    return written.ok ? { ok: true } : written;
  };

  return {
    sources,
    /** The file has been read, so an edit has something to edit. */
    ready: text !== null,
    /** The file does not parse: the view shows nothing it cannot stand on. */
    fileProblem: unreadable
      ? "marketplaces.json could not be opened with this vault's key."
      : parsed && !parsed.ok
        ? parsed.message
        : null,
    stateOf: (reference: string): ListingState =>
      listings.get(reference) ?? { status: "idle" },
    load,
    add: (raw: string) => edit((current) => withMarketplace(current, raw)),
    remove: (reference: string) => {
      listings.delete(reference);
      return edit((current) => withoutMarketplace(current, reference));
    },
    restore: () => edit(withDefaultMarketplace),
  };
}
