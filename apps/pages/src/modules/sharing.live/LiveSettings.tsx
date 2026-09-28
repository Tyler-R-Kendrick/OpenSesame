/**
 * Settings › Live sessions (ADR 0150): the session this tab hosts, and the
 * routes its sessions may use. Contributed by `sharing.live`, so the tab
 * exists only while Live sessions is on.
 */

import { LiveHostPanel } from "./LiveHostPanel.js";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";

export function LiveSettings() {
  return (
    <>
      <LiveHostPanel />
      <LiveRoutesPanel />
    </>
  );
}
