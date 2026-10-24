/**
 * What the Form to start a live session holds, and whether it may start
 * (ADR 0150 §2, ADR 0196): the fields as the person has set them, whether
 * there is anything to lend a device, and the one press.
 */

import { liveHostStartDisabledReason } from "@opensesame/app-core/lib/live/form-disabled-reason.js";
import type { Admission } from "@opensesame/app-core/lib/live/host.js";
import type { SharePolicy } from "@opensesame/app-core/lib/live/messages.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { grantIdentities } from "@opensesame/app-core/lib/local-share-grants.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useEffect, useState } from "react";
import { useOfferedConnections } from "./live-hooks.js";
import { startInput, useStartSession } from "./live-start.js";
import { useLiveTransport } from "./live-transport-hooks.js";

export type Scope = "vault" | "items" | "none";

function useHostPeople(
  setPeople: (people: { id: string; name: string }[]) => void,
): void {
  useEffect(() => {
    let live = true;
    void readLocalDirectory(vaultStore.activeTomb?.() ?? "")
      .then((directory) => {
        if (!live) return;
        setPeople(
          grantIdentities(directory.entries)
            .filter((entry) => entry.kind === "person")
            .map((entry) => ({ id: entry.id, name: entry.name })),
        );
      })
      .catch(() => {
        if (live) setPeople([]);
      });
    return () => {
      live = false;
    };
  }, [setPeople]);
}

export function useHostForm(initialTitle = "") {
  const [title, setTitle] = useState(initialTitle);
  const [scope, setScope] = useState<Scope>("vault");
  const [devices, setDevices] = useState<"no" | "ask">("no");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [policy, setPolicy] = useState<SharePolicy>("use");
  const [admission, setAdmission] = useState<Admission>("open");
  const [audience, setAudience] = useState<"anyone" | "all-users" | "people">(
    "anyone",
  );
  const [peopleIds, setPeopleIds] = useState<ReadonlySet<string>>(new Set());
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [minutes, setMinutes] = useState(10_080);
  const { starting, failed, start } = useStartSession();
  useHostPeople(setPeople);
  const { transport, loaded, refused } = useLiveTransport();
  // Devices are offered a choice only where there is something to lend.
  const lend = useOfferedConnections().length > 0;
  const asks = lend && devices === "ask";
  const shares =
    scope === "vault" ||
    (scope === "items" && chosen.size > 0) ||
    (scope === "none" && asks);
  const audienceReady = audience !== "people" || peopleIds.size > 0;
  const ready =
    loaded &&
    refused === null &&
    !starting &&
    title.trim().length > 0 &&
    audienceReady &&
    shares;
  const reason = ready
    ? undefined
    : !audienceReady
      ? "Choose at least one person."
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
    values: {
      title,
      scope,
      devices,
      chosen,
      policy,
      admission,
      minutes,
      audience,
      peopleIds,
      people,
    },
    set: {
      title: setTitle,
      scope: setScope,
      devices: setDevices,
      chosen: setChosen,
      policy: setPolicy,
      admission: setAdmission,
      minutes: setMinutes,
      audience: setAudience,
      peopleIds: setPeopleIds,
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
          audience,
          peopleIds: [...peopleIds],
        }),
      );
    },
  };
}
