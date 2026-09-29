import type {
  CodeChannel,
  SecondStepId,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconEdit, IconPlus, IconTrash } from "../../../components/Icons.js";
import { MethodRow } from "./MethodRow.js";
import type { MethodKind, SheetRequest } from "./MethodSheet.js";

type Open = (kind: MethodKind, view: SheetRequest["view"]) => () => void;

/**
 * The second steps a sign-in service sends — email, text — and the service
 * itself. Email and text codes are asked after a key, and only a service can
 * send them: with none, the row's key sets one; with one, it adds the code.
 * Removing the service is not offered while a code depends on it.
 */
export function CodeRows({
  secondSteps,
  hasService,
  service,
  busy,
  open,
}: {
  secondSteps: SecondStepId[];
  hasService: boolean;
  service: string;
  busy: boolean;
  open: Open;
}) {
  const codeInUse =
    secondSteps.includes("email") || secondSteps.includes("sms");
  return (
    <>
      <CodeRow
        channel="email"
        label="Email code"
        on={secondSteps.includes("email")}
        hasService={hasService}
        busy={busy}
        open={open}
      />
      <CodeRow
        channel="sms"
        label="Text message"
        on={secondSteps.includes("sms")}
        hasService={hasService}
        busy={busy}
        open={open}
      />
      <MethodRow
        kind="service"
        label="Sign-in service"
        state={hasService ? "Set" : "Off"}
        on={hasService}
        sub={
          hasService
            ? `${service}. Sends email and text codes.`
            : "Where email and text codes are requested from."
        }
        action={
          hasService ? (
            <div className="actions">
              <IconKey
                label="Change"
                small
                disabled={busy}
                onClick={open("service", "change")}
              >
                <IconEdit size={16} />
              </IconKey>
              {codeInUse ? null : (
                <IconKey
                  label="Remove"
                  small
                  disabled={busy}
                  onClick={open("service", "remove")}
                >
                  <IconTrash size={16} />
                </IconKey>
              )}
            </div>
          ) : (
            <IconKey
              label="Add"
              small
              disabled={busy}
              onClick={open("service", "add")}
            >
              <IconPlus size={16} />
            </IconKey>
          )
        }
      />
    </>
  );
}

function CodeRow({
  channel,
  label,
  on,
  hasService,
  busy,
  open,
}: {
  channel: CodeChannel;
  label: string;
  on: boolean;
  hasService: boolean;
  busy: boolean;
  open: Open;
}) {
  return (
    <MethodRow
      kind={channel}
      label={label}
      state={on ? "On" : "Off"}
      on={on}
      sub={
        !hasService
          ? "Needs a sign-in service to send it."
          : on
            ? "Offered at step 2. Sent by your sign-in service."
            : "For a lost phone. Sent by your sign-in service to an address you confirm."
      }
      action={
        <IconKey
          label={on ? "Remove" : hasService ? "Add" : "Set sign-in service"}
          small
          disabled={busy}
          onClick={
            hasService
              ? open(channel, on ? "remove" : "add")
              : open("service", "add")
          }
        >
          {on ? <IconTrash size={16} /> : <IconPlus size={16} />}
        </IconKey>
      }
    />
  );
}
