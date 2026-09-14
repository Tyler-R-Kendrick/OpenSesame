/**
 * The vault's filters on a phone.
 *
 * The rail carries these on a desktop. Where the rail is gone they used to
 * become a scrolling row of chips pinned above the list — a 49px band, always
 * on screen, for a control you touch rarely, and the one whose active chip was
 * solid ink on canvas: the highest-contrast element on the screen, louder than
 * the vault's own items and louder than the "new item" key beside it. That is
 * the hierarchy upside down.
 *
 * So the filters move behind one key, the way a phone puts a filtered view
 * behind one: the key carries a dot while a filter is narrowing the list, and
 * the sheet names every road with the count it would show. Nothing is lost by
 * closing it — the list's own status line already ends in the filter's name,
 * so the screen never stops saying what is being looked at.
 */

import { type RefObject, useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { IconFilter, IconX } from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { itemTypeId, typePlural } from "../../lib/vault/item-types.js";
import type { Folder, VaultItem } from "../../lib/vault/model.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

/** One road out of the sheet: where it goes, what it is called, how many. */
type Road = {
  key: string;
  to: string;
  label: string;
  count: number;
  active: boolean;
  guideId?: string;
};

function buildRoads(
  items: VaultItem[],
  folders: Folder[],
  typeIds: readonly string[],
  filter: string,
  folderId: string | null,
): Road[] {
  const live = items.filter((item) => item.deletedAt === null);
  const roads: Road[] = [
    {
      key: "all",
      to: "/vault",
      label: "All items",
      count: live.length,
      active: filter === "all" && !folderId,
    },
    {
      key: "favorites",
      to: "/vault?f=favorites",
      label: "Favorites",
      count: live.filter((item) => item.favorite).length,
      active: filter === "favorites",
      guideId: "vault.filter.favorites",
    },
  ];
  for (const typeId of typeIds) {
    roads.push({
      key: typeId,
      to: `/vault?f=${typeId}`,
      label: typePlural(typeId),
      count: live.filter((item) => itemTypeId(item) === typeId).length,
      active: filter === typeId,
      guideId: typeId === "login" ? "vault.filter.logins" : undefined,
    });
  }
  for (const folder of folders) {
    roads.push({
      key: `folder:${folder.id}`,
      to: `/vault?folder=${encodeURIComponent(folder.id)}`,
      label: folder.name,
      count: live.filter((item) => item.folderId === folder.id).length,
      active: folderId === folder.id,
    });
  }
  roads.push({
    key: "trash",
    to: "/vault?f=trash",
    label: "Trash",
    count: items.filter((item) => item.deletedAt !== null).length,
    active: filter === "trash",
  });
  return roads;
}

/** A road a guide can name. Same markup as the untracked ones. */
function GuidedRoad({
  road,
  guideId,
  onPick,
}: { road: Road; guideId: string; onPick: () => void }) {
  const ref = useGuideTarget<HTMLAnchorElement>(guideId);
  return <RoadRow road={road} onPick={onPick} anchorRef={ref} />;
}

function RoadRow({
  road,
  onPick,
  anchorRef,
}: {
  road: Road;
  onPick: () => void;
  anchorRef?: (element: HTMLAnchorElement | null) => void;
}) {
  return (
    <Link
      ref={anchorRef}
      to={road.to}
      className={`vfilter__road${road.active ? " is-active" : ""}`}
      aria-current={road.active ? "page" : undefined}
      onClick={onPick}
    >
      <span className="vfilter__name">{road.label}</span>
      <span className="vfilter__n">{road.count}</span>
    </Link>
  );
}

export function VaultFilterMenu({
  items,
  folders,
  typeIds,
  filter,
  folderId,
}: {
  items: VaultItem[];
  folders: Folder[];
  typeIds: readonly string[];
  filter: string;
  folderId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const openRef = useGuideTarget<HTMLButtonElement>("vault.filter");
  // Stable: `useModalFocus` keeps this in its effect deps, and a fresh
  // arrow each render would re-run the effect — re-focusing Close and
  // taking the keyboard off whatever the person was on. `useConnectors`
  // re-renders on a timer, so that fired on its own.
  const close = useCallback(() => setOpen(false), []);
  useModalFocus(open, sheetRef, closeRef, close);

  const roads = useMemo(
    () => buildRoads(items, folders, typeIds, filter, folderId),
    [items, folders, typeIds, filter, folderId],
  );
  const active = roads.find((road) => road.active);
  // A filter can be in force with no road to show for it: `?f=login` survives
  // trashing the last login, and a deep link may name a type this vault holds
  // none of. The list is narrowed either way, so the key says so rather than
  // claiming the resting state.
  const resting = filter === "all" && !folderId;
  const narrowed = !resting;
  const label = `Filter — ${active?.label ?? (resting ? "All items" : filter)}`;

  return (
    <div className="vfilter">
      <button
        ref={openRef}
        type="button"
        className={`icon-btn icon-btn--sm vfilter__open${narrowed ? " is-narrowed" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <IconFilter size={15} />
      </button>

      {open ? (
        <FilterSheet
          roads={roads}
          heading={active?.label ?? "All items"}
          sheetRef={sheetRef}
          closeRef={closeRef}
          close={close}
        />
      ) : null}
    </div>
  );
}

/** The sheet itself: the scrim, the head, and one row per road. */
function FilterSheet({
  roads,
  heading,
  sheetRef,
  closeRef,
  close,
}: {
  roads: Road[];
  heading: string;
  sheetRef: RefObject<HTMLDivElement | null>;
  closeRef: RefObject<HTMLButtonElement | null>;
  close: () => void;
}) {
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={close}
      />
      <div
        ref={sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label="Filter items"
        aria-modal="true"
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>Filter</h2>
            <p>{heading}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            ref={closeRef}
            onClick={close}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">
          <div className="vfilter__roads">
            {roads.map((road) =>
              road.guideId ? (
                <GuidedRoad
                  key={road.key}
                  road={road}
                  guideId={road.guideId}
                  onPick={close}
                />
              ) : (
                <RoadRow key={road.key} road={road} onPick={close} />
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
