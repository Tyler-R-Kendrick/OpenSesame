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
import {
  ADMISSIONS,
  AUDIENCES,
  DEVICES,
  DURATIONS,
  ItemChoice,
  POLICIES,
  PeopleChoice,
  Pick,
  SCOPES,
  routesSummary,
} from "./live-host-form-parts.js";
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
      <Pick
        id="live-scope"
        name="Share"
        value={values.scope}
        options={lend ? SCOPES : SCOPES.filter((one) => one.value !== "none")}
        onChange={set.scope}
      />
      {values.scope === "items" ? (
        <ItemChoice chosen={values.chosen} onChange={set.chosen} />
      ) : null}
      <Pick
        id="live-policy"
        name="Values"
        value={values.policy}
        options={POLICIES}
        onChange={set.policy}
      />
      {lend ? (
        <Pick
          id="live-devices"
          name="Devices"
          value={values.devices}
          options={DEVICES}
          onChange={set.devices}
        />
      ) : null}
      <Pick
        id="live-audience"
        name="Share with"
        value={values.audience}
        options={AUDIENCES}
        onChange={set.audience}
      />
      {values.audience === "people" ? (
        <PeopleChoice
          people={values.people}
          peopleIds={values.peopleIds}
          onChange={set.peopleIds}
        />
      ) : null}
      <Pick
        id="live-admission"
        name="Who gets in"
        value={values.admission}
        options={ADMISSIONS}
        onChange={set.admission}
      />
      <Pick
        id="live-minutes"
        name="For"
        value={values.minutes}
        options={DURATIONS}
        onChange={set.minutes}
      />
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
