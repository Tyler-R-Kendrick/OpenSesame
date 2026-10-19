import { listProtectorUnlockTabs } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import { listAvailableUnlockMethods } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type {
  LocalRetiredCommand,
  LocalRetiredInspection,
  LocalVaultSecurityPort,
} from "@opensesame/vault-core/local-vault-security.js";
import { useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { IconCheck, IconTrash } from "../../../components/Icons.js";
import { IconShield } from "../../../components/Icons.js";
import { useVault, useVaultStore } from "../../../lib/vault/hooks.js";
import {
  RetiredEnrollmentForm,
  RetiredFactorForm,
  RetiredPrimaryForm,
} from "./RetiredCredentialForms.js";
import { SheetFrame } from "./SheetFrame.js";
import { useRetiredOperation } from "./useRetiredOperation.js";
type RetiredPort = Pick<
  LocalVaultSecurityPort,
  "beginRetired" | "isRetiredResultCurrent"
>;
export function RetiredCredentialsPanel() {
  const { guest, decoy, status, header } = useVault();
  const store = useVaultStore();
  const [open, setOpen] = useState(false);
  if (guest || decoy || status !== "unlocked") return null;
  const methods = [
    ...new Set([
      ...listAvailableUnlockMethods(header),
      ...listProtectorUnlockTabs(header),
    ]),
  ];
  return (
    <section className="panel set__security" id="retired-passwords">
      <div className="panel__head">
        <h2>Retired passwords</h2>
        <button className="btn" type="button" onClick={() => setOpen(true)}>
          Manage retired passwords
        </button>
      </div>
      <div className="panel__body">
        <p>
          Recognize use of an old password on this device. Your current key and
          configured second step protect every review and change.
        </p>
      </div>
      {open ? (
        <RetiredCredentialsSheet
          port={store}
          methods={methods}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}
export function RetiredCredentialsSheet({
  port,
  methods,
  onClose,
}: { port: RetiredPort; methods: readonly string[]; onClose: () => void }) {
  const operation = useRetiredOperation(port);
  const [command, setCommand] = useState<LocalRetiredCommand | null>({
    kind: "inspect",
  });
  const choose = (next: LocalRetiredCommand) => setCommand(next);
  return (
    <SheetFrame
      title="Retired passwords"
      mark={<IconShield size={18} />}
      busy={operation.busy}
      onClose={onClose}
    >
      <FailureNotice
        id="retired-credentials"
        title="Retired passwords"
        message={operation.error}
      />
      {operation.delivery ? <output>{operation.delivery}</output> : null}
      {operation.challenge ? (
        <RetiredFactorForm
          routes={operation.challenge.routes}
          busy={operation.busy}
          complete={(kind, code) => void operation.complete({ kind, code })}
          send={(channel) => void operation.send(channel)}
        />
      ) : command ? (
        <>
          <p>
            Verify your current key to{" "}
            {command.kind === "inspect"
              ? "review retired passwords"
              : "make this change"}
            .
          </p>
          <RetiredPrimaryForm
            methods={methods}
            busy={operation.busy}
            submit={(primary) => {
              const accepted = command;
              setCommand(null);
              void operation.begin(primary, accepted);
            }}
          />
        </>
      ) : null}
      {!operation.challenge &&
      !command &&
      !operation.result &&
      !operation.busy ? (
        <button
          className="icon-btn"
          aria-label="Try a fresh review"
          title="Try a fresh review"
          type="button"
          onClick={() => choose({ kind: "inspect" })}
        >
          <IconCheck size={18} />
        </button>
      ) : null}
      {operation.result && !command && !operation.challenge ? (
        <RetiredInspection result={operation.result} choose={choose} />
      ) : null}
    </SheetFrame>
  );
}
function RetiredInspection({
  result,
  choose,
}: {
  result: LocalRetiredInspection;
  choose: (command: LocalRetiredCommand) => void;
}) {
  return (
    <>
      {result.stale ? (
        <output>
          Some records no longer match the current vault protection. Clear stale
          records before adding another password.
        </output>
      ) : null}
      <h3>Recognized passwords</h3>
      {result.traps.length === 0 ? (
        <p>No retired passwords are enrolled.</p>
      ) : (
        <ul>
          {result.traps.map((trap, index) => (
            <li key={trap.id}>
              Password {index + 1} ·{" "}
              {trap.response === "reject" ? "Refuse access" : "Synthetic vault"}{" "}
              · expires {new Date(trap.expiresAt).toLocaleDateString()}{" "}
              <button
                className="icon-btn"
                aria-label={`Remove password ${index + 1}`}
                title={`Remove password ${index + 1}`}
                type="button"
                onClick={() =>
                  choose({
                    kind: "change",
                    change: { type: "remove", id: trap.id },
                  })
                }
              >
                <IconTrash size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {result.stale ? (
        <button
          className="icon-btn"
          aria-label="Clear stale records"
          title="Clear stale records"
          type="button"
          onClick={() =>
            choose({ kind: "change", change: { type: "clear-stale" } })
          }
        >
          <IconTrash size={18} />
        </button>
      ) : (
        <RetiredEnrollmentForm busy={false} choose={choose} />
      )}
      <h3>Activity on this device</h3>
      {result.events.length === 0 ? (
        <p>No recorded activity.</p>
      ) : (
        <ul>
          {result.events.map((event, index) => (
            <li key={`${event.at}-${index}`}>
              {event.type === "retired_credential_observed"
                ? "Retired password used"
                : "Synthetic vault interaction"}{" "}
              · {new Date(event.at).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
      {result.events.length > 0 ? (
        <button
          className="icon-btn"
          aria-label="Clear activity"
          title="Clear activity"
          type="button"
          onClick={() =>
            choose({ kind: "change", change: { type: "clear-events" } })
          }
        >
          <IconTrash size={18} />
        </button>
      ) : null}
    </>
  );
}
