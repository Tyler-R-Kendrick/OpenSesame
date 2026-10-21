/**
 * Starting a live session (ADR 0150 §2): what it shares, how, for how long,
 * and who gets in. Nothing but the carriers the owner named leaves this
 * browser until someone is let in: the peer connection, its ICE servers and
 * address hints wait for admission. Where the app has a connection to lend, the
 * owner also says whether a device may ask to use them (ADR 0196).
 */

import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlay } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { HostChoices, routesSummary } from "./live-host-form-parts.js";
import { useHostForm } from "./live-host-form-state.js";

export { routesSummary } from "./live-host-form-parts.js";

export function LiveHostForm({
  initialTitle = "",
}: {
  initialTitle?: string;
}) {
  const {
    values,
    set,
    lend,
    ready,
    reason,
    transport,
    refused,
    failed,
    submit,
  } = useHostForm(initialTitle);
  return (
    <form
      className="setup__stack"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <FieldShell
        id="live-title"
        label="Session name"
        value={values.title}
        onValueChange={(next) => set.title(next.slice(0, 64))}
      />
      <HostChoices values={values} set={set} lend={lend} />
      {refused ? (
        <StatusMark tone="err" label={refused} />
      ) : (
        <StatusMark
          tone="idle"
          label={routesSummary(transport, transport.carriers.length === 0)}
        />
      )}
      {failed ? <StatusMark tone="err" label={failed} /> : null}
      <FormCommit
        label="Share this vault"
        disabled={!ready}
        disabledReason={reason}
        icon={<IconPlay size={18} />}
      />
    </form>
  );
}
