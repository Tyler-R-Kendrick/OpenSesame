import { useId, useState } from "react";
import {
  type LocalAccessRequest,
  createLocalAccessRequest,
} from "../../lib/local-access-requests.js";
import type { LocalApplication } from "../../lib/local-applications.js";
import {
  type LocalDirectory,
  LocalDirectoryError,
} from "../../lib/local-directory.js";
import { currentLocalIdentitySession } from "../../lib/local-sessions.js";
import { LocalAgentKeys } from "../identity/LocalAgentKeys.js";
import { LocalIdentitySession } from "../identity/LocalIdentitySession.js";

function formText(data: FormData, name: string) {
  const value = data.get(name);
  if (value === null || value instanceof File)
    throw new LocalDirectoryError(
      "Complete every request field before submitting.",
    );
  return value;
}

export function LocalRequestForm({
  tomb,
  directory,
  applications,
  busy,
  run,
  close,
}: {
  tomb: string;
  directory: LocalDirectory;
  applications: LocalApplication[];
  busy: boolean;
  run: (
    action: () => Promise<LocalAccessRequest> | Promise<void>,
    message: string,
  ) => Promise<boolean>;
  close: () => void;
}) {
  const id = useId();
  async function submit(data: FormData) {
    const done = await run(async () => {
      const principalId = formText(data, "principalId");
      const applicationId = formText(data, "applicationId");
      const redirectUri = formText(data, "redirectUri");
      const scopes = formText(data, "scopes");
      const reason = formText(data, "reason");
      const session = await currentLocalIdentitySession(tomb, principalId);
      if (!session)
        throw new LocalDirectoryError(
          "Authenticate the requesting identity before creating this request.",
        );
      return createLocalAccessRequest(tomb, session, {
        applicationId,
        redirectUri,
        scopes: scopes.trim().split(/\s+/),
        reason,
      });
    }, "Local request created. No access was granted.");
    if (done) close();
  }
  return (
    <fieldset disabled={busy}>
      <legend>New local request</legend>
      <RequestIdentityFields
        tomb={tomb}
        directory={directory}
        busy={busy}
        formId={id}
      />
      <form
        id={id}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(new FormData(event.currentTarget));
        }}
      >
        <RequestApplicationFields
          applications={applications}
          directory={directory}
        />
        <div className="field">
          <label className="label" htmlFor={`${id}-reason`}>
            Reason
          </label>
          <textarea
            id={`${id}-reason`}
            name="reason"
            required
            maxLength={240}
          />
        </div>
        <div className="actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!applications.length}
          >
            Create local request
          </button>
          <button type="button" className="btn" onClick={close}>
            Cancel request
          </button>
        </div>
      </form>
    </fieldset>
  );
}

function RequestIdentityFields({
  tomb,
  directory,
  busy,
  formId,
}: { tomb: string; directory: LocalDirectory; busy: boolean; formId: string }) {
  const id = useId();
  const people = directory.entries.filter(
    (entry) =>
      entry.enabled && (entry.kind === "person" || entry.kind === "agent"),
  );
  const [principalId, setPrincipalId] = useState(people[0]?.id ?? "");
  const person = people.find((entry) => entry.id === principalId);
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={id}>
          Requesting identity
        </label>
        <select
          id={id}
          name="principalId"
          form={formId}
          value={principalId}
          onChange={(event) => setPrincipalId(event.target.value)}
          required
        >
          <option value="">Choose a person or agent</option>
          {people.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} · {entry.id}
            </option>
          ))}
        </select>
      </div>
      {person?.kind === "person" ? (
        <LocalIdentitySession
          key={person.id}
          tomb={tomb}
          principalId={person.id}
          disabled={busy}
        />
      ) : null}
      {person?.kind === "agent" ? (
        <LocalAgentKeys
          key={person.id}
          tomb={tomb}
          principalId={person.id}
          disabled={busy}
          enabled={person.enabled}
        />
      ) : null}
    </>
  );
}

function RequestApplicationFields({
  applications,
  directory,
}: { applications: LocalApplication[]; directory: LocalDirectory }) {
  const id = useId();
  const [applicationId, setApplicationId] = useState(
    applications[0]?.applicationId ?? "",
  );
  const application = applications.find(
    (entry) => entry.applicationId === applicationId,
  );
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`${id}-application`}>
          Application
        </label>
        <select
          id={`${id}-application`}
          name="applicationId"
          value={applicationId}
          required
          onChange={(event) => setApplicationId(event.target.value)}
        >
          <option value="">Choose a registered application</option>
          {applications.map((entry) => (
            <option key={entry.applicationId} value={entry.applicationId}>
              {directory.entries.find((item) => item.id === entry.applicationId)
                ?.name ?? entry.applicationId}{" "}
              · {entry.applicationId}
            </option>
          ))}
        </select>
      </div>
      <div key={applicationId}>
        <div className="field">
          <label className="label" htmlFor={`${id}-callback`}>
            Registered callback
          </label>
          <select
            id={`${id}-callback`}
            name="redirectUri"
            defaultValue={application?.redirectUris[0] ?? ""}
            required
          >
            <option value="">Choose an exact callback</option>
            {application?.redirectUris.map((uri) => (
              <option key={uri} value={uri}>
                {uri}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-scopes`}>
            Requested scopes
          </label>
          <input
            id={`${id}-scopes`}
            name="scopes"
            defaultValue="openid"
            required
            maxLength={2048}
          />
        </div>
      </div>
      <p className="hint">
        Available: {application?.scopes.join(", ") || "-"}. Current role policy
        still applies; approval does not bypass it.
      </p>
    </>
  );
}
