import {
  type DeadmanPlan,
  type DeadmanStatus,
  commitDeadmanSwitch,
  disarmDeadmanSwitch,
  prepareDeadmanSwitch,
} from "@opensesame/app-core/lib/deadman/index.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import type { VaultItem } from "@opensesame/vault-core";
import type { Dispatch, FormEvent, SetStateAction } from "react";

const NOTICE_ID = "deadman-switch";

export type DeadmanPanelModel = Readonly<{
  tomb: string;
  items: VaultItem[];
  open: boolean;
  status: DeadmanStatus | null;
  busy: boolean;
  said: string;
  error: string;
  plan: DeadmanPlan | null;
  releaseKey: string;
  stored: boolean;
  selected: ReadonlySet<string>;
  timeoutDays: number;
  relayUrl: string;
  webhookUrl: string;
  relayToken: string;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setSaid: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  setPlan: Dispatch<SetStateAction<DeadmanPlan | null>>;
  setReleaseKey: Dispatch<SetStateAction<string>>;
  setStored: Dispatch<SetStateAction<boolean>>;
  setSelected: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setTimeoutDays: Dispatch<SetStateAction<number>>;
  setRelayUrl: Dispatch<SetStateAction<string>>;
  setWebhookUrl: Dispatch<SetStateAction<string>>;
  setRelayToken: Dispatch<SetStateAction<string>>;
  refresh: () => void;
}>;

export function beginDeadmanPanel({
  status,
  setSaid,
  setError,
  setPlan,
  setReleaseKey,
  setStored,
  setSelected,
  setTimeoutDays,
  setRelayUrl,
  setOpen,
}: DeadmanPanelModel) {
  dismissNotice(NOTICE_ID);
  setSaid("");
  setError("");
  setPlan(null);
  setReleaseKey("");
  setStored(false);
  setSelected(new Set());
  setTimeoutDays(30);
  setRelayUrl(status?.relayUrl ?? "");
  setOpen(true);
}

export function createDeadmanActions({
  tomb,
  items,
  busy,
  selected,
  timeoutDays,
  relayUrl,
  webhookUrl,
  relayToken,
  plan,
  stored,
  setBusy,
  setError,
  setPlan,
  setReleaseKey,
  setOpen,
  setSaid,
  refresh,
}: DeadmanPanelModel) {
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await prepareDeadmanSwitch({
        tomb,
        items,
        itemIds: [...selected],
        timeoutDays,
        relayUrl,
        webhookUrl,
        relayToken,
      });
      setPlan(next);
      setReleaseKey(next.releaseKey);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not prepare it.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!plan || !stored || busy) return;
    setBusy(true);
    setError("");
    try {
      await commitDeadmanSwitch(plan);
      setOpen(false);
      setSaid("Deadman switch is on.");
      setPlan(null);
      setReleaseKey("");
      refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not turn it on.",
      );
    } finally {
      setBusy(false);
    }
  }

  function disarm() {
    dismissNotice(NOTICE_ID);
    setBusy(true);
    setError("");
    void disarmDeadmanSwitch(tomb)
      .then(() => {
        setOpen(false);
        setSaid("Deadman switch is off.");
        setPlan(null);
        setReleaseKey("");
        refresh();
      })
      .catch((caught) => {
        setStatusNotice({
          id: NOTICE_ID,
          tone: "err",
          title: "Deadman switch",
          body:
            caught instanceof Error
              ? caught.message
              : "The relay did not confirm the change.",
        });
      })
      .finally(() => setBusy(false));
  }
  return { prepare, commit, disarm };
}
