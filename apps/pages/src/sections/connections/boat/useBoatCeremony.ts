/**
 * The Boat claim ceremony as panel state: email → claim at Boat →
 * sealed connection → billing. Network goes through the lease-fenced
 * native provider transport (boat.dev does not answer CORS for the
 * vault origin); with External connectors off, the ceremony says so
 * instead of fetching directly.
 */
import {
  BOAT_ORIGIN,
  type BoatAccount,
  type BoatClaimStart,
  createBoatCheckout,
  exchangeBoatAssertion,
  pollBoatClaim,
  readBoatAccount,
  readBoatAssertion,
  saveBoatConnection,
  savedBoatConnection,
  startBoatClaim,
} from "@opensesame/app-core/lib/boat-ceremony.js";
import type { Connection } from "@opensesame/app-core/lib/connections.js";
import {
  publicConnectorFields,
  revokeDeviceConnection,
} from "@opensesame/app-core/lib/device-connectors.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useCallback, useEffect, useRef, useState } from "react";

export const boatCeremonyDependencies = {
  transport: (): { fetch: typeof fetch } => {
    const transport = nativeProviderTransport();
    if (
      transport.supportsNativeOrigin &&
      !transport.supportsNativeOrigin(BOAT_ORIGIN)
    )
      throw new Error(
        "Enable External connectors with boat.dev egress to claim Boat.",
      );
    return transport;
  },
};

export type BoatCeremonyStage =
  | "email"
  | "claiming"
  | "billing"
  | "ready"
  | "saved";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function accountFor(connectionId: string): Promise<{
  accessToken: string;
  current: BoatAccount;
}> {
  const assertion = readBoatAssertion(connectionId);
  if (!assertion) throw new Error("No Boat identity is sealed here.");
  const { fetch: fetchImpl } = boatCeremonyDependencies.transport();
  const accessToken = await exchangeBoatAssertion(fetchImpl, assertion);
  return {
    accessToken,
    current: await readBoatAccount(fetchImpl, accessToken),
  };
}

async function pollUntilClaimed(
  started: BoatClaimStart,
  isCurrent: () => boolean,
): Promise<{ accessToken: string; identityAssertion: string } | null> {
  for (;;) {
    await sleep(started.intervalSeconds * 1000);
    if (!isCurrent()) return null;
    const result = await pollBoatClaim(
      boatCeremonyDependencies.transport().fetch,
      started.claimToken,
    );
    if (!isCurrent()) return null;
    if (result.status === "claimed") return result;
  }
}

interface ClaimFlow {
  email: string;
  existingId?: string;
  isCurrent: () => boolean;
  onStarted: (started: BoatClaimStart) => void;
}

/** Register, wait out the person's claim, seal the identity. */
async function runClaimFlow(flow: ClaimFlow): Promise<BoatAccount | null> {
  const started = await startBoatClaim(
    boatCeremonyDependencies.transport().fetch,
    flow.email,
  );
  flow.onStarted(started);
  const claimed = await pollUntilClaimed(started, flow.isCurrent);
  if (!claimed || !flow.isCurrent()) return null;
  const current = await readBoatAccount(
    boatCeremonyDependencies.transport().fetch,
    claimed.accessToken,
  );
  await saveBoatConnection({
    email: flow.email.trim(),
    login: current.login || current.email,
    identityAssertion: claimed.identityAssertion,
    ...(flow.existingId ? { existingId: flow.existingId } : {}),
  });
  return current;
}

interface SavedActions {
  saved: Connection | null;
  setBusy: (busy: boolean) => void;
  setFailure: (failure: string) => void;
  setAccount: (account: BoatAccount | null) => void;
  setStage: (stage: BoatCeremonyStage) => void;
  setClaim: (claim: BoatClaimStart | null) => void;
  stopPolling: () => void;
  fail: (caught: unknown) => void;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}

function useBoatSavedActions(actions: SavedActions) {
  const { saved, setBusy, setFailure, setAccount, setStage, fail } = actions;
  const onCheckBilling = useCallback(() => {
    if (!saved) return;
    setBusy(true);
    setFailure("");
    void accountFor(saved.connectionId)
      .then(({ current }) => {
        setAccount(current);
        setStage(current.blockedReason ? "billing" : "ready");
        setBusy(false);
      })
      .catch(fail);
  }, [fail, saved, setAccount, setBusy, setFailure, setStage]);
  const onOpenCheckout = useCallback(() => {
    if (!saved) return;
    setBusy(true);
    setFailure("");
    void (async () => {
      try {
        const { accessToken, current } = await accountFor(saved.connectionId);
        setAccount(current);
        const url = await createBoatCheckout(
          boatCeremonyDependencies.transport().fetch,
          accessToken,
        );
        window.open(url, "_blank", "noopener,noreferrer");
        setBusy(false);
      } catch (caught) {
        fail(caught);
      }
    })();
  }, [fail, saved, setAccount, setBusy, setFailure]);
  const onForget = useCallback(() => {
    if (!saved) return;
    setBusy(true);
    setFailure("");
    actions.stopPolling();
    void revokeDeviceConnection(saved.connectionId)
      .then(() => {
        setStage("email");
        setAccount(null);
        actions.setClaim(null);
        setBusy(false);
        actions.onFlash({ tone: "ok", text: "Boat connection forgotten." });
        actions.onChanged();
      })
      .catch(fail);
  }, [actions, fail, saved, setAccount, setBusy, setFailure, setStage]);
  return { onCheckBilling, onOpenCheckout, onForget };
}

export function useBoatCeremony(
  connection: Connection | null,
  onFlash: (flash: Flash) => void,
  onChanged: () => void,
) {
  const saved = connection ?? savedBoatConnection();
  const savedFields = saved ? publicConnectorFields(saved.connectionId) : {};
  const [email, setEmail] = useState(savedFields.account_email ?? "");
  const [stage, setStage] = useState<BoatCeremonyStage>(saved ? "saved" : "email");
  const [claim, setClaim] = useState<BoatClaimStart | null>(null);
  const [account, setAccount] = useState<BoatAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const generation = useRef(0);
  const stopPolling = useCallback(() => void (generation.current += 1), []);
  useEffect(() => stopPolling, [stopPolling]);
  const fail = useCallback((caught: unknown) => {
    setFailure(caught instanceof Error ? caught.message : "That did not work.");
    setBusy(false);
  }, []);

  // A saved connection opens on its live billing state, not a guess.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!saved || refreshed.current) return;
    refreshed.current = true;
    void accountFor(saved.connectionId)
      .then(({ current }) => {
        setAccount(current);
        setStage(current.blockedReason ? "billing" : "ready");
      })
      .catch(() => {});
  }, [saved]);

  const onStartClaim = useCallback(() => {
    setBusy(true);
    setFailure("");
    const run = ++generation.current;
    void runClaimFlow({
      email,
      ...(saved ? { existingId: saved.connectionId } : {}),
      isCurrent: () => generation.current === run,
      onStarted: (started) => {
        setClaim(started);
        setStage("claiming");
        setBusy(false);
      },
    })
      .then((current) => {
        if (!current || generation.current !== run) return;
        setAccount(current);
        setStage(current.blockedReason ? "billing" : "ready");
        setBusy(false);
        onFlash({ tone: "ok", text: "Boat claimed and saved on this device." });
        onChanged();
      })
      .catch((caught: unknown) => {
        if (generation.current !== run) return;
        setStage(savedBoatConnection() ? "saved" : "email");
        fail(caught);
      });
  }, [email, fail, onChanged, onFlash, saved]);

  const { onCheckBilling, onOpenCheckout, onForget } = useBoatSavedActions({
    saved,
    setBusy,
    setFailure,
    setAccount,
    setStage,
    setClaim,
    stopPolling,
    fail,
    onFlash,
    onChanged,
  });

  return {
    savedId: saved?.connectionId ?? null,
    savedEmail: savedFields.account_email ?? "",
    savedLogin: savedFields.account_login ?? "",
    email,
    onEmail: setEmail,
    stage,
    claim,
    account,
    busy,
    failure,
    onStartClaim,
    onCancelClaim: useCallback(() => {
      stopPolling();
      setClaim(null);
      setStage(savedBoatConnection() ? "saved" : "email");
    }, [stopPolling]),
    onCheckBilling,
    onOpenCheckout,
    onForget,
  };
}
