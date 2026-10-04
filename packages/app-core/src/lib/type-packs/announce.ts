/**
 * The pack journey, told in the bell tray (ADR 0164).
 *
 * The Item types screen shows each row's state itself; this is for the person
 * who switched a type on and moved away. One notice, `type-packs`, follows
 * the whole run and is updated in place — "Installing item types · 3 of 18",
 * then a short "18 item types on" that clears itself — so a bulk switch is
 * one line in the tray, never eighteen. A pack that failed keeps a notice of
 * its own with a retry, because only that one needs the person back.
 */

import { packEntry } from "@opensesame/vault-item-types";
import { dismissNotice, setStatusNotice } from "../notices.js";
import { getPackSnapshot, statusOf } from "./state.js";

const RUN_ID = "type-packs";
const OPEN = { to: "/settings/vaults#item-types", label: "Open item types" };
/** How long a finished run stays in the tray. */
const LINGER_MS = 5000;

let lingering: ReturnType<typeof setTimeout> | undefined;

/** Set by `installer.ts`, which owns retry; avoids an import cycle. */
type AnnounceSeams = { retry: (id: string) => void };

export const announceSeams: AnnounceSeams = {
  retry: () => undefined,
};

function failedIds(): string[] {
  const { status } = getPackSnapshot();
  return Object.keys(status).filter((id) => status[id]?.phase === "failed");
}

export function announcePacks(): void {
  const snapshot = getPackSnapshot();
  clearTimeout(lingering);
  for (const id of failedIds()) {
    const title = packEntry(id)?.title ?? id;
    setStatusNotice({
      id: `type-pack:${id}`,
      tone: "err",
      title: `${title} did not install`,
      body: statusOf(id, snapshot).reason ?? "It did not install.",
      retry: () => announceSeams.retry(id),
      retryLabel: `Try ${title} again`,
      open: OPEN,
    });
  }
  if (snapshot.pending > 0) {
    const total = snapshot.settled + snapshot.pending;
    setStatusNotice({
      id: RUN_ID,
      tone: "info",
      title: total === 1 ? "Installing an item type" : "Installing item types",
      body:
        total === 1
          ? "Downloading, then installing. Nothing else waits on it."
          : `${snapshot.settled} of ${total} done. Nothing else waits on it.`,
      open: OPEN,
    });
    return;
  }
  if (snapshot.settled === 0) {
    dismissNotice(RUN_ID);
    return;
  }
  const failed = failedIds().length;
  const done = snapshot.settled - failed;
  if (done > 0) {
    setStatusNotice({
      id: RUN_ID,
      tone: "info",
      title:
        done === 1 ? "Item type installed" : `${done} item types installed`,
      body: "Ready to use in the new-item picker.",
      open: OPEN,
    });
    lingering = setTimeout(() => dismissNotice(RUN_ID), LINGER_MS);
  } else {
    dismissNotice(RUN_ID);
  }
}
