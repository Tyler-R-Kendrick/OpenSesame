import {
  type DeadmanRelease as Release,
  loadDeadmanRelease,
  releaseDeadmanSwitch,
} from "@opensesame/app-core/lib/deadman/index.js";
import type { VaultItem } from "@opensesame/vault-core";
import { type FormEvent, useEffect, useState } from "react";
import { useVault } from "../lib/vault/hooks.js";
import { DeadmanReleaseView } from "./DeadmanReleaseView.js";
import "./deadman-release.css";

export function DeadmanRelease() {
  const { tomb, guest } = useVault();
  const [release, setRelease] = useState<Release | null>(null);
  const [items, setItems] = useState<VaultItem[] | null>(null);
  const [releaseKey, setReleaseKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // A released tab is still a tab. Hiding it drops the decrypted copy even
  // though the vault itself was never opened.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") setItems(null);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  useEffect(() => {
    if (guest) {
      setError("A deadman switch is not available in a guest session.");
      return;
    }
    let live = true;
    void loadDeadmanRelease(tomb)
      .then((next) => {
        if (live) setRelease(next);
      })
      .catch((caught) => {
        if (live)
          setError(
            caught instanceof Error
              ? caught.message
              : "No deadman switch is available here.",
          );
      });
    return () => {
      live = false;
    };
  }, [guest, tomb]);

  function open(event: FormEvent) {
    event.preventDefault();
    if (busy || !release) return;
    setBusy(true);
    setError("");
    void releaseDeadmanSwitch(tomb, releaseKey)
      .then((opened) => {
        setItems(opened);
        setReleaseKey("");
      })
      .catch((caught) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "That release key did not open the switch.",
        );
      })
      .finally(() => setBusy(false));
  }

  return (
    <DeadmanReleaseView
      release={release}
      items={items}
      releaseKey={releaseKey}
      busy={busy}
      error={error}
      open={open}
      setReleaseKey={setReleaseKey}
    />
  );
}
