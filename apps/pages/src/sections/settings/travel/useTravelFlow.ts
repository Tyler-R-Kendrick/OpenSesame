/**
 * The state behind Settings › Vaults › Travel (ADR 0143): which vaults are
 * marked safe, the packed bundle while it waits for both acknowledgements,
 * and the bundle and code on the way home — one state for the two ceremonies
 * that run in sheets.
 */

import { MAX_TRAVEL_BUNDLE_BYTES } from "@opensesame/app-core/lib/travel/bundle-format.js";
import {
  type DeparturePackage,
  type OpenedReturn,
  clearTravelRemnants,
  departForTravel,
  openTravelReturn,
  packTravelDeparture,
  returnFromTravel,
} from "@opensesame/app-core/lib/travel/index.js";
import { useState } from "react";
import { useDeviceVaults } from "../../../bindings/vaults.js";
import { useVault } from "../../../lib/vault/hooks.js";
import {
  type TravelNotice,
  departedNotice,
  travelRefusalText,
} from "./TravelViews.js";
import { remnantsNotice, returnedNotice } from "./return-text.js";

export type TravelMode =
  | { kind: "plan" }
  | { kind: "packed"; pkg: DeparturePackage }
  | { kind: "return" }
  | { kind: "preview"; opened: OpenedReturn };

type Notice = TravelNotice | null;

const NO_ACK = { bundleSaved: false, codeRecorded: false };

function useTravelState() {
  const { status, guest } = useVault();
  const [mode, setMode] = useState<TravelMode>({ kind: "plan" });
  const [safe, setSafe] = useState<ReadonlySet<string>>(new Set());
  const [ack, setAck] = useState(NO_ACK);
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
        setNotice({
          tone: "err",
          text: caught instanceof Error ? caught.message : String(caught),
        });
      })
      .finally(() => setBusy(false));
  }

  function reset(next: Notice = null): void {
    setMode({ kind: "plan" });
    setAck(NO_ACK);
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
    bundle,
    code,
    grants,
    busy,
    notice,
    setMode,
    setSafe,
    setAck,
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
      state.setSafe(new Set());
      state.reset(departedNotice(receipt));
      onDone();
    });

  const toggleSafe = (id: string) => {
    state.setNotice(null);
    state.setSafe((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return { pack, depart, toggleSafe };
}

function returnSteps(state: TravelState, onDone: () => void) {
  const open = () =>
    state.run(async () => {
      if (!state.bundle) return;
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
    ...returnSteps(state, onDone),
  };
}
