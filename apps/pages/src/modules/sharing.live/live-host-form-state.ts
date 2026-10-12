/**
 * What the Form to start a live session holds, and whether it may start
 * (ADR 0150 §2, ADR 0195): the fields as the person has set them, whether
 * there is anything to lend a device, and the one press.
 */

import { liveHostStartDisabledReason } from "@opensesame/app-core/lib/live/form-disabled-reason.js";
import type { Admission } from "@opensesame/app-core/lib/live/host.js";
import type { SharePolicy } from "@opensesame/app-core/lib/live/messages.js";
import { useState } from "react";
import { useOfferedConnections } from "./live-hooks.js";
import { startInput, useStartSession } from "./live-start.js";
import { useLiveTransport } from "./live-transport-hooks.js";

export type Scope = "vault" | "items" | "none";

export function useHostForm() {
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<Scope>("items");
  const [devices, setDevices] = useState<"no" | "ask">("no");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [policy, setPolicy] = useState<SharePolicy>("use");
  const [admission, setAdmission] = useState<Admission>("invite");
  const [minutes, setMinutes] = useState(60);
  const { starting, failed, start } = useStartSession();
  const { transport, loaded, refused } = useLiveTransport();
  // Devices are offered a choice only where there is something to lend.
  const lend = useOfferedConnections().length > 0;
  const asks = lend && devices === "ask";
  const shares =
    scope === "vault" ||
    (scope === "items" && chosen.size > 0) ||
    (scope === "none" && asks);
  const ready =
    loaded &&
    refused === null &&
    !starting &&
    title.trim().length > 0 &&
    shares;
  const reason = ready
    ? undefined
    : liveHostStartDisabledReason({
        loaded,
        refused,
        starting,
        title,
        scope,
        chosenCount: chosen.size,
        devices: asks,
      });
  return {
    values: { title, scope, devices, chosen, policy, admission, minutes },
    set: {
      title: setTitle,
      scope: setScope,
      devices: setDevices,
      chosen: setChosen,
      policy: setPolicy,
      admission: setAdmission,
      minutes: setMinutes,
    },
    lend,
    ready,
    reason,
    transport,
    refused,
    failed,
    /** The one press: start with the fields as they stand now. */
    submit: () => {
      if (!ready) return;
      start(
        startInput({
          title,
          scope,
          chosen,
          policy,
          admission,
          minutes,
          devices: asks,
        }),
      );
    },
  };
}
