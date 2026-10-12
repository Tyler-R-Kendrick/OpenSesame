/**
 * Starting a session from the Form (ADR 0150 §2): the one press, its answer,
 * and what a failed start says. A start that is refused is a sentence on the
 * Form, never a rejected promise nobody holds.
 */

import type { Admission } from "@opensesame/app-core/lib/live/host.js";
import type { SharePolicy } from "@opensesame/app-core/lib/live/messages.js";
import { LiveRoutesRefused } from "@opensesame/app-core/lib/live/routes.js";
import {
  type HostInput,
  startHosting,
} from "@opensesame/app-core/lib/live/session.js";
import { TransportRefused } from "@opensesame/app-core/lib/live/transport-store.js";
import { useCallback, useState } from "react";
import { liveUiSeams } from "./live-hooks.js";
import { settledTransport } from "./live-transport-hooks.js";

/** What the Form holds at the press. */
export type StartForm = Readonly<{
  title: string;
  scope: "vault" | "items" | "none";
  chosen: ReadonlySet<string>;
  policy: SharePolicy;
  admission: Admission;
  minutes: number;
  /** Devices may ask to use the owner's connections (ADR 0195). */
  devices: boolean;
}>;

function shareScope(form: StartForm): HostInput["scope"] {
  if (form.scope === "none") return { kind: "none" };
  return form.scope === "vault"
    ? { kind: "vault" }
    : { kind: "items", ids: [...form.chosen] };
}

/**
 * The session's input: the press's fields as they stand now, and the routes
 * read again once every edit asked for so far has been sealed. The Form's own
 * copy of the routes may be a moment behind the Routes panel where they were
 * just added, so it is not what a session starts from.
 */
export async function startInput(form: StartForm): Promise<HostInput> {
  const fields: Omit<HostInput, "routes"> = {
    title: form.title.trim(),
    scope: shareScope(form),
    policy: form.policy,
    admission: form.admission,
    minutes: form.minutes,
    devices: form.devices,
    transport: liveUiSeams.transport,
    carriers: liveUiSeams.carriers,
  };
  return { ...fields, routes: await settledTransport() };
}

export type Starter = Readonly<{
  /** A start is under way: a second press would replace the first. */
  starting: boolean;
  /** Why the last start did not happen; empty when it did or none was made. */
  failed: string;
  /**
   * Start with `input`, or with what it comes to: the Form hands over the
   * press's fields and the routes still being read, so the press is counted
   * (`starting`) from the moment it is made.
   */
  start: (input: HostInput | Promise<HostInput>) => void;
}>;

export function useStartSession(): Starter {
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState("");
  const start = useCallback((input: HostInput | Promise<HostInput>) => {
    setFailed("");
    setStarting(true);
    Promise.resolve(input)
      .then(startHosting)
      .catch((error) =>
        setFailed(
          error instanceof LiveRoutesRefused ||
            error instanceof TransportRefused
            ? error.message
            : "The live session could not start",
        ),
      )
      .finally(() => setStarting(false));
  }, []);
  return { starting, failed, start };
}
