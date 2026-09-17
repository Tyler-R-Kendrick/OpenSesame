import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconX } from "../../components/Icons.js";
import { type Connection, listConnections } from "../../lib/connections.js";
import { useVault } from "../../lib/vault/hooks.js";
import type { SecretItem, VaultItem } from "../../lib/vault/model.js";
import { AssignStep } from "./GrantCeremonyAssign.js";
import { CodeCard, MintStep } from "./GrantCeremonyMint.js";
import { ScopeStep } from "./GrantCeremonyScope.js";
import { TargetStep } from "./GrantCeremonySteps.js";
import { accessErrorText } from "./access-errors.js";
import {
  type Assignment,
  CEREMONY_STEPS,
  type CeremonyStep,
  type GrantTarget,
  type MintedCode,
  type ScopeInput,
} from "./grant-ceremony-types.js";

function isSecret(item: VaultItem): item is SecretItem {
  return item.kind === "secret" && item.deletedAt === null;
}

export function GrantCeremony({
  online,
  hostConfigured,
  preselectConnection,
  preselectSecret,
  onClose,
}: {
  online: boolean;
  hostConfigured: boolean;
  preselectConnection: string | null;
  preselectSecret: string | null;
  onClose: () => void;
}) {
  const vault = useVault();
  const [step, setStep] = useState<CeremonyStep>("target");
  const [target, setTarget] = useState<GrantTarget | null>(null);
  const [assignment, setAssignment] = useState<Assignment>({ kind: "anyone" });
  const [scope, setScope] = useState<ScopeInput | null>(null);
  const [code, setCode] = useState<MintedCode | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    if (!hostConfigured) {
      setConnections([]);
      setLoadError(null);
      return;
    }
    try {
      const rows = await listConnections();
      if (run.current !== id) return;
      setConnections(rows);
      setLoadError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setConnections([]);
      setLoadError(accessErrorText(caught));
    }
  }, [hostConfigured]);

  useEffect(() => {
    void load();
  }, [load]);

  const secrets = useMemo(
    () =>
      vault.status === "unlocked"
        ? vault.items
            .filter(isSecret)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [vault.items, vault.status],
  );

  useEffect(() => {
    if (target !== null) return;
    if (preselectConnection && connections) {
      const found = connections.find(
        (connection) => connection.connectionId === preselectConnection,
      );
      if (found) {
        setTarget({ kind: "connection", connection: found });
        setStep("assign");
      }
      return;
    }
    if (preselectSecret) {
      const found = secrets.find((item) => item.id === preselectSecret);
      if (found) {
        setTarget({ kind: "secret", secret: found });
        setStep("assign");
      }
    }
  }, [connections, preselectConnection, preselectSecret, secrets, target]);

  // A secret grants through its ConnectionRef; the offer item needs the
  // connection's id, so the ref has to resolve against the Host's list.
  const resolved = useMemo(() => {
    if (target === null || connections === null) return null;
    if (target.kind === "connection") return target.connection;
    return (
      connections.find(
        (connection) =>
          connection.connectionRef === target.secret.connectionRef,
      ) ?? null
    );
  }, [target, connections]);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Grant access</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Cancel"
          title="Cancel"
          onClick={onClose}
        >
          <IconX size={15} />
        </button>
      </div>

      <div className="panel__body">
        {step !== "code" ? (
          <ol className="grant-steps" aria-label="Grant access steps">
            {CEREMONY_STEPS.map((entry) => (
              <li
                key={entry.id}
                className={
                  entry.id === step
                    ? "grant-steps__step is-current"
                    : "grant-steps__step"
                }
                aria-current={entry.id === step ? "step" : undefined}
              >
                {entry.label}
              </li>
            ))}
          </ol>
        ) : null}
        {step === "target" ? (
          <TargetStep
            connections={connections}
            loadError={loadError}
            secrets={secrets}
            vaultStatus={vault.status}
            onPick={(picked) => {
              setTarget(picked);
              setStep("assign");
            }}
            onRetry={() => void load()}
          />
        ) : null}
        {step === "assign" && target !== null ? (
          <AssignStep
            target={target}
            connection={resolved}
            onBack={
              preselectConnection || preselectSecret
                ? null
                : () => setStep("target")
            }
            onAssign={(next) => {
              setAssignment(next);
              setStep("scope");
            }}
          />
        ) : null}
        {step === "scope" && target !== null ? (
          <ScopeStep
            target={target}
            connection={resolved}
            connectionsReady={connections !== null}
            online={online}
            onBack={() => setStep("assign")}
            onScope={(next) => {
              setScope(next);
              setStep("mint");
            }}
          />
        ) : null}
        {step === "mint" && target !== null && scope !== null ? (
          <MintStep
            target={target}
            connection={resolved}
            assignment={assignment}
            scope={scope}
            online={online}
            onBack={() => setStep("scope")}
            onMinted={(minted, bindWarning) => {
              setCode({
                claimToken: minted.claimToken,
                userCode: minted.userCode,
                expiresAt: minted.offer.expiresAt,
                assignment,
                bindWarning,
              });
              setStep("code");
            }}
          />
        ) : null}
        {step === "code" && code !== null ? (
          <CodeCard code={code} onDone={onClose} />
        ) : null}
      </div>
    </section>
  );
}
