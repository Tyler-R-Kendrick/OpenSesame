import { listProtectorUnlockTabs } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import { listAvailableUnlockMethods } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type {
  LocalCanaryCommand,
  LocalCanaryReceiver,
  LocalVaultSecurityPort,
} from "@opensesame/vault-core/local-vault-security.js";
import { useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { IconArrowRight, IconShield } from "../../../components/Icons.js";
import { useVault, useVaultStore } from "../../../lib/vault/hooks.js";
import { CanaryReceiverForm } from "./CanaryCredentialForms.js";
import { CanaryResults } from "./CanaryResults.js";
import {
  RetiredFactorForm,
  RetiredPrimaryForm,
} from "./RetiredCredentialForms.js";
import { SheetFrame } from "./SheetFrame.js";
import { useCanaryOperation } from "./useCanaryOperation.js";
type CanaryPort = Pick<
  LocalVaultSecurityPort,
  "beginCanary" | "isCanaryResultCurrent"
>;
export function CanaryCredentialsPanel() {
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
    <section className="panel set__security" id="agent-canaries">
      <div className="panel__head">
        <h2>Agent canaries</h2>
        <button
          className="icon-btn"
          type="button"
          aria-label="Manage agent canaries"
          onClick={() => setOpen(true)}
        >
          <IconShield size={18} />
        </button>
      </div>
      {open ? (
        <CanaryCredentialsSheet
          port={store}
          methods={methods}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}
export function CanaryCredentialsSheet({
  port,
  methods,
  onClose,
}: { port: CanaryPort; methods: readonly string[]; onClose: () => void }) {
  const operation = useCanaryOperation(port);
  const [receiver, setReceiver] = useState<LocalCanaryReceiver | null>(null);
  const [command, setCommand] = useState<LocalCanaryCommand | null>(null);
  const choose = (action: LocalCanaryCommand["action"]) => {
    if (receiver) setCommand({ receiver, action });
  };
  return (
    <SheetFrame
      title="Agent canaries"
      mark={<IconShield size={18} />}
      busy={operation.busy}
      onClose={onClose}
    >
      <FailureNotice
        id="canary-owner-operation"
        title="Agent canaries"
        message={operation.error}
      />
      {operation.delivery ? <output>{operation.delivery}</output> : null}
      {!receiver ? (
        <CanaryReceiverForm
          choose={(profile, kind) => {
            setReceiver(profile);
            setCommand({ receiver: profile, action: { kind } });
          }}
        />
      ) : null}
      {operation.challenge ? (
        <RetiredFactorForm
          routes={operation.challenge.routes}
          busy={operation.busy}
          complete={(kind, code) => void operation.complete({ kind, code })}
          send={(channel) => void operation.send(channel)}
        />
      ) : command ? (
        <RetiredPrimaryForm
          methods={methods}
          busy={operation.busy}
          submit={(primary) => {
            const accepted = command;
            setCommand(null);
            void operation.begin(primary, accepted);
          }}
        />
      ) : null}
      {operation.result && !command && !operation.challenge ? (
        <CanaryResults result={operation.result} choose={choose} />
      ) : null}
      {receiver &&
      !command &&
      !operation.challenge &&
      !operation.result &&
      !operation.busy ? (
        <button
          className="icon-btn"
          type="button"
          aria-label="Try fresh canary review"
          onClick={() => choose({ kind: "inspect" })}
        >
          <IconArrowRight size={18} />
        </button>
      ) : null}
    </SheetFrame>
  );
}
