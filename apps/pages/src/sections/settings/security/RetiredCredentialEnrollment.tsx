import {
  MAX_RETIRED_CREDENTIAL_TRAPS,
  type RetiredCredentialResponse,
} from "@opensesame/app-core/lib/retired-credentials/index.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";

export type RetiredEnrollmentModel = {
  current: string;
  retired: string;
  response: RetiredCredentialResponse;
  acknowledged: boolean;
  blocked: boolean;
  full: boolean;
  ready: boolean;
  setCurrent(value: string): void;
  setRetired(value: string): void;
  setResponse(value: RetiredCredentialResponse): void;
  setAcknowledged(value: boolean): void;
};

function EnrollmentFields({ form }: { form: RetiredEnrollmentModel }) {
  return (
    <>
      <FieldShell
        label="Current vault password"
        type="password"
        value={form.current}
        onValueChange={form.setCurrent}
        autoComplete="off"
        disabled={form.blocked}
      />
      <FieldShell
        label="Selected retired password"
        type="password"
        value={form.retired}
        onValueChange={form.setRetired}
        autoComplete="off"
        disabled={form.blocked || form.full}
      />
      <fieldset className="duress__pick" disabled={form.blocked}>
        <legend className="duress__legend">When observed</legend>
        <ul className="duress__choices">
          <li>
            <label className="duress__choice">
              <input
                type="radio"
                name="retired-response"
                checked={form.response === "reject"}
                onChange={() => form.setResponse("reject")}
              />
              <span>Record and reject</span>
            </label>
          </li>
          <li>
            <label className="duress__choice">
              <input
                type="radio"
                name="retired-response"
                checked={form.response === "synthetic_decoy"}
                onChange={() => form.setResponse("synthetic_decoy")}
              />
              <span>Open a synthetic decoy</span>
            </label>
          </li>
        </ul>
      </fieldset>
      <label className="duress__ack">
        <input
          type="checkbox"
          checked={form.acknowledged}
          disabled={form.blocked}
          onChange={(event) => form.setAcknowledged(event.target.checked)}
        />
        <span>
          I understand that retaining a password-only verifier allows offline
          password guessing, including passwords reused elsewhere. Old autofill
          and legitimate users can trigger it. Evidence stays in this browser
          and can be bypassed or lost.
        </span>
      </label>
    </>
  );
}

export function RetiredCredentialEnrollment({
  form,
  count,
  supported,
  busy,
  onEnroll,
}: {
  form: RetiredEnrollmentModel;
  count: number;
  supported: boolean;
  busy: boolean;
  onEnroll: () => void;
}) {
  return (
    <form
      aria-label="Retired password enrollment"
      onSubmit={(event) => {
        event.preventDefault();
        if (form.ready) onEnroll();
      }}
    >
      <CeremonyShell
        name="Retired passwords · this device"
        facts={[
          ...(!supported
            ? [
                {
                  key: "Management",
                  value:
                    "read-only while additional vault factors protect this vault",
                },
              ]
            : []),
          {
            key: "Retained",
            value: `${count} of ${MAX_RETIRED_CREDENTIAL_TRAPS}`,
          },
          {
            key: "Evidence",
            value: "local to this browser; no independent notification",
          },
          {
            key: "Decoy",
            value: "synthetic data only; no real vault or external authority",
          },
        ]}
        primary={{
          label: "Enroll retired password",
          submit: true,
          disabled: !form.ready,
          busy,
          onClick: () => {},
        }}
      >
        <EnrollmentFields form={form} />
      </CeremonyShell>
    </form>
  );
}
