/**
 * The state behind Settings › Vaults › Travel (ADR 0143): which vaults are
 * marked safe, the packed bundle while it waits for both acknowledgements,
 * and the bundle and code on the way home.
 */

import {
  type DeparturePackage,
  type OpenedReturn,
  departForTravel,
  openTravelReturn,
  packTravelDeparture,
  returnFromTravel,
} from "@opensesame/app-core/lib/travel/index.js";
import { useState } from "react";
import { useDeviceVaults } from "../../../bindings/vaults.js";
import type { StatusTone } from "../../../components/StatusMark.js";
import { useVault } from "../../../lib/vault/hooks.js";
import {
  type TravelNotice,
  departedNotice,
  returnedNotice,
  travelRefusalText,
} from "./TravelViews.js";

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
    busy,
    notice,
    setMode,
    setSafe,
    setAck,
    setBundle,
    setCode,
    setNotice,
    run,
    reset,
    refuse,
  };
}

type TravelState = ReturnType<typeof useTravelState>;

function departureSteps(state: TravelState, openId: string | undefined) {
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
      state.setSafe(new Set());
      state.reset(departedNotice(receipt));
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

function returnSteps(state: TravelState) {
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
      const outcome = await returnFromTravel(opened);
      if (!outcome.ok) return state.refuse(outcome.code);
      state.reset(returnedNotice(outcome.receipt));
    });

  const chooseBundle = (file: File) =>
    state.run(async () => {
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

  return { open, bringHome, chooseBundle, typeCode, startReturn };
}

/** The panel's state and the steps it can take. */
export function useTravelFlow() {
  const state = useTravelState();
  const openId = useDeviceVaults().find((vault) => vault.state === "open")?.id;
  return {
    ...state,
    ...departureSteps(state, openId),
    ...returnSteps(state),
  };
}
