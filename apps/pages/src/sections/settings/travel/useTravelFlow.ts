/**
 * The state behind Settings › Vaults › Travel (ADR 0143): which vaults are
 * marked safe, the packed bundle while it waits for both acknowledgements,
 * and the bundle and code on the way home — one state for the two ceremonies
 * that run in sheets.
 */

import { MAX_TRAVEL_BUNDLE_BYTES } from "@opensesame/app-core/lib/travel/bundle-format.js";
import {
  type DeparturePackage,
  type ItemsPackage,
  type OpenedItemsReturn,
  type OpenedReturn,
  clearTravelRemnants,
  departForTravel,
  hideItemsForTravel,
  isItemsBundle,
  openTravelItemsReturn,
  openTravelReturn,
  packTravelDeparture,
  packTravelItemDeparture,
  returnFromTravel,
  returnItemsFromTravel,
} from "@opensesame/app-core/lib/travel/index.js";
import {
  readSafeFlags,
  writeSafeFlags,
} from "@opensesame/app-core/lib/travel/safe-flags.js";
import { useEffect, useRef, useState } from "react";
import { useDeviceVaults } from "../../../bindings/vaults.js";
import { useVault } from "../../../lib/vault/hooks.js";
import {
  type TravelNotice,
  departedNotice,
  travelRefusalText,
} from "./TravelViews.js";
import {
  hiddenNotice,
  itemsRefusalText,
  itemsReturnRefusalText,
  itemsReturnedNotice,
} from "./items-text.js";
import { remnantsNotice, returnedNotice } from "./return-text.js";

export type TravelMode =
  | { kind: "plan" }
  | { kind: "packed"; pkg: DeparturePackage }
  | { kind: "return" }
  | { kind: "preview"; opened: OpenedReturn }
  | { kind: "items" }
  | { kind: "items_packed"; pkg: ItemsPackage }
  | { kind: "items_preview"; opened: OpenedItemsReturn };

type Notice = TravelNotice | null;

const NO_ACK = { bundleSaved: false, codeRecorded: false };
const NONE: ReadonlySet<string> = new Set();

function useTravelState() {
  const { status, guest } = useVault();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [mode, setMode] = useState<TravelMode>({ kind: "plan" });
  const vaultIds = useDeviceVaults().map((vault) => vault.id);
  // Chosen once, at home: the marks are remembered, not asked for again.
  const [safe, setSafeNow] = useState<ReadonlySet<string>>(() =>
    readSafeFlags(vaultIds),
  );
  const setSafe = (next: ReadonlySet<string>) => {
    setSafeNow(next);
    void writeSafeFlags(next).catch(() => {});
  };
  const [ack, setAck] = useState(NO_ACK);
  // What to leave home is chosen for this ceremony only: nothing remembers it,
  // because a remembered list would be the device saying what is hidden.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(NONE);
  const [copiesKnown, setCopiesKnown] = useState(false);
  const [bundle, setBundle] = useState<{ name: string; json: string } | null>(
    null,
  );
  const [code, setCode] = useState("");
  // A bundle's site grants come back only when the person ticks for them.
  const [grants, setGrants] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  function run(task: () => Promise<void>): void {
    setBusy(true);
    setNotice(null);
    void task()
      .catch((caught) => {
        if (!alive.current) return;
        setNotice({
          tone: "err",
          text: caught instanceof Error ? caught.message : String(caught),
        });
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  }

  function reset(next: Notice = null): void {
    setMode({ kind: "plan" });
    setAck(NO_ACK);
    setChosen(NONE);
    setCopiesKnown(false);
    setBundle(null);
    setCode("");
    setGrants(false);
    setNotice(next);
  }

  function refuse(code: string): void {
    setNotice({ tone: "err", text: travelRefusalText(code) });
  }

  return {
    owner: status === "unlocked" && !guest,
    mode,
    safe,
    ack,
    chosen,
    copiesKnown,
    bundle,
    code,
    grants,
    busy,
    notice,
    setMode,
    setSafe,
    setAck,
    setChosen,
    setCopiesKnown,
    setBundle,
    setCode,
    setGrants,
    setNotice,
    run,
    reset,
    refuse,
  };
}

type TravelState = ReturnType<typeof useTravelState>;

function departureSteps(
  state: TravelState,
  openId: string | undefined,
  onDone: () => void,
) {
  const pack = () =>
    state.run(async () => {
      const safe = [...state.safe, ...(openId ? [openId] : [])];
      const outcome = await packTravelDeparture(safe);
      if (!outcome.ok) return state.refuse(outcome.code);
      state.setAck(NO_ACK);
      state.setMode({ kind: "packed", pkg: outcome.pkg });
    });

  const depart = (pkg: DeparturePackage) =>
    state.run(async () => {
      const outcome = await departForTravel(pkg, state.ack);
      if (!outcome.ok) return state.refuse(outcome.code);
      const { receipt } = outcome;
      // A removal cut short keeps the package: the same press finishes it.
      if (receipt.completion === "incomplete") {
        return state.setNotice(departedNotice(receipt));
      }
      state.reset(departedNotice(receipt));
      onDone();
    });

  const toggleSafe = (id: string) => {
    state.setNotice(null);
    const next = new Set(state.safe);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    state.setSafe(next);
  };

  return { pack, depart, toggleSafe };
}

function failure(text: string): TravelNotice {
  return { tone: "err", text };
}

function itemsSteps(state: TravelState, onDone: () => void) {
  const toggleItem = (id: string) => {
    state.setNotice(null);
    const next = new Set(state.chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    state.setChosen(next);
  };

  const packItems = () =>
    state.run(async () => {
      const outcome = await packTravelItemDeparture([...state.chosen]);
      if (!outcome.ok)
        return state.setNotice(failure(itemsRefusalText(outcome)));
      state.setAck(NO_ACK);
      state.setCopiesKnown(false);
      state.setMode({ kind: "items_packed", pkg: outcome.pkg });
    });

  const hideItems = (pkg: ItemsPackage) =>
    state.run(async () => {
      const outcome = await hideItemsForTravel(pkg, state.ack);
      if (!outcome.ok)
        return state.setNotice(failure(itemsRefusalText(outcome)));
      // A trace that would not clear keeps the package: the same press finishes it.
      if (outcome.receipt.completion === "incomplete") {
        return state.setNotice(hiddenNotice(outcome.receipt));
      }
      state.reset(hiddenNotice(outcome.receipt));
      onDone();
    });

  return { toggleItem, packItems, hideItems };
}

function returnSteps(state: TravelState, onDone: () => void) {
  const openItems = async (bundleJson: string) => {
    const outcome = await openTravelItemsReturn({
      bundleJson,
      returnCode: state.code,
    });
    if (!outcome.ok)
      return state.setNotice(failure(itemsReturnRefusalText(outcome.code)));
    state.setMode({ kind: "items_preview", opened: outcome.opened });
  };

  const bringItemsBack = (opened: OpenedItemsReturn) =>
    state.run(async () => {
      const outcome = await returnItemsFromTravel(opened);
      if (!outcome.ok)
        return state.setNotice(failure(itemsReturnRefusalText(outcome.code)));
      state.reset(itemsReturnedNotice(outcome.receipt));
      onDone();
    });

  const open = () =>
    state.run(async () => {
      if (!state.bundle) return;
      if (isItemsBundle(state.bundle.json)) return openItems(state.bundle.json);
      const outcome = await openTravelReturn({
        bundleJson: state.bundle.json,
        returnCode: state.code,
      });
      if (!outcome.ok) return state.refuse(outcome.code);
      state.setMode({ kind: "preview", opened: outcome.opened });
    });

  const bringHome = (opened: OpenedReturn) =>
    state.run(async () => {
      const outcome = await returnFromTravel(opened, { grants: state.grants });
      if (!outcome.ok) return state.refuse(outcome.code);
      state.reset(returnedNotice(outcome.receipt));
      onDone();
    });

  const chooseBundle = (file: File) =>
    state.run(async () => {
      // Refused by size before a byte of it is read into the page.
      if (file.size > MAX_TRAVEL_BUNDLE_BYTES) {
        state.setBundle(null);
        return state.refuse("bundle_too_large");
      }
      state.setBundle({ name: file.name, json: await file.text() });
    });

  const typeCode = (next: string) => {
    state.setCode(next);
    state.setNotice(null);
  };

  const startReturn = () => {
    state.setNotice(null);
    state.setMode({ kind: "return" });
  };

  const clearRemnants = (after: () => void) =>
    state.run(async () => {
      const outcome = await clearTravelRemnants();
      if (!outcome.ok) return state.refuse(outcome.code);
      state.setNotice(remnantsNotice(outcome));
      after();
    });

  return {
    open,
    bringItemsBack,
    bringHome,
    chooseBundle,
    typeCode,
    startReturn,
    clearRemnants,
  };
}

/**
 * The panel's state and the steps it can take. `onDone` runs when a
 * departure has removed everything or a return has put everything back: the
 * ceremony is over and its sheet can close.
 */
export function useTravelFlow(onDone: () => void) {
  const state = useTravelState();
  const openId = useDeviceVaults().find((vault) => vault.state === "open")?.id;
  return {
    ...state,
    ...departureSteps(state, openId, onDone),
    ...itemsSteps(state, onDone),
    ...returnSteps(state, onDone),
  };
}
