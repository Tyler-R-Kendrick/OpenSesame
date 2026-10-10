/**
 * Starting a live session (ADR 0150 §2): what it shares, how, for how long,
 * and who gets in. Nothing but the carriers the owner named leaves this
 * browser until someone is let in: the peer connection, its ICE servers and
 * address hints wait for admission.
 */

import { liveHostStartDisabledReason } from "@opensesame/app-core/lib/live/form-disabled-reason.js";
import type { Admission } from "@opensesame/app-core/lib/live/host.js";
import type { SharePolicy } from "@opensesame/app-core/lib/live/messages.js";
import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlay } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { liveUiSeams } from "./live-hooks.js";
import {
  ADMISSIONS,
  DURATIONS,
  ItemChoice,
  POLICIES,
  Pick,
  SCOPES,
  routesSummary,
} from "./live-host-form-parts.js";
import { useStartSession } from "./live-start.js";
import { useLiveTransport } from "./live-transport-hooks.js";

export { routesSummary } from "./live-host-form-parts.js";

export function LiveHostForm() {
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"vault" | "items">("items");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [policy, setPolicy] = useState<SharePolicy>("use");
  const [admission, setAdmission] = useState<Admission>("invite");
  const [minutes, setMinutes] = useState(60);
  const { starting, failed, start } = useStartSession();
  const { transport, loaded, refused } = useLiveTransport();
  const ready =
    loaded &&
    refused === null &&
    !starting &&
    title.trim().length > 0 &&
    (scope === "vault" || chosen.size > 0);

  return (
    <form
      className="setup__stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        start({
          title: title.trim(),
          scope:
            scope === "vault"
              ? { kind: "vault" }
              : { kind: "items", ids: [...chosen] },
          policy,
          admission,
          minutes,
          transport: liveUiSeams.transport,
          routes: transport,
          carriers: liveUiSeams.carriers,
        });
      }}
    >
      <FieldShell
        id="live-title"
        label="Session name"
        value={title}
        onValueChange={(next) => setTitle(next.slice(0, 64))}
      />
      <Pick
        id="live-scope"
        name="Share"
        value={scope}
        options={SCOPES}
        onChange={setScope}
      />
      {scope === "items" ? (
        <ItemChoice chosen={chosen} onChange={setChosen} />
      ) : null}
      <Pick
        id="live-policy"
        name="Values"
        value={policy}
        options={POLICIES}
        onChange={setPolicy}
      />
      <Pick
        id="live-admission"
        name="Who gets in"
        value={admission}
        options={ADMISSIONS}
        onChange={setAdmission}
      />
      <Pick
        id="live-minutes"
        name="For"
        value={minutes}
        options={DURATIONS}
        onChange={setMinutes}
      />
      {refused ? (
        <StatusMark tone="err" label={refused} />
      ) : (
        <StatusMark tone="idle" label={routesSummary(transport)} />
      )}
      {failed ? <StatusMark tone="err" label={failed} /> : null}
      <FormCommit
        label="Start the live session"
        disabled={!ready}
        disabledReason={
          !ready
            ? liveHostStartDisabledReason({
                loaded,
                refused,
                starting,
                title,
                scope,
                chosenCount: chosen.size,
              })
            : undefined
        }
        icon={<IconPlay size={18} />}
      />
    </form>
  );
}
