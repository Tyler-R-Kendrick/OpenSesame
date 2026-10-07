import { isRealAuthorityBlocked } from "@opensesame/app-core/lib/decoy-session.js";
import {
  type comparePrivatePassword,
  type createPrivateCredential,
  passwordWorkflowAudit,
  passwordWorkflowFind,
  passwordWorkflowInventory,
} from "@opensesame/app-core/lib/vault/password-workflows.js";
import { pinTombAuthority } from "@opensesame/app-core/lib/vfs.js";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSearchParams } from "react-router";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconSecret, IconX } from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { SupportContext } from "../../tutorial/support-context.js";
import { pinSecurityOwner } from "../settings/security/security-owner.js";
import {
  CredentialWorkflow,
  PasswordWorkflow,
  ReadWorkflow,
  TemplateWorkflow,
} from "./PasswordWorkflowForms.js";
import { useAddEntry } from "./add-menu.js";
type WorkflowResult =
  | Awaited<ReturnType<typeof passwordWorkflowFind>>
  | Awaited<ReturnType<typeof passwordWorkflowInventory>>
  | Awaited<ReturnType<typeof passwordWorkflowAudit>>
  | Awaited<ReturnType<typeof createPrivateCredential>>
  | Awaited<ReturnType<typeof comparePrivatePassword>>
  | { saved: string; references?: number };
import "./password-workflows.css";

export type PerformWorkflow = (
  operation: (check: () => void) => Promise<WorkflowResult>,
) => Promise<void>;

function DiscoveryWorkflow({
  busy,
  perform,
}: { busy: boolean; perform: PerformWorkflow }) {
  const [queries, setQueries] = useState("");
  const findRef = useGuideTarget<HTMLButtonElement>("vault.workflow.find");
  const inventoryRef = useGuideTarget<HTMLButtonElement>(
    "vault.workflow.inventory",
  );
  const auditRef = useGuideTarget<HTMLButtonElement>("vault.workflow.audit");
  return (
    <fieldset disabled={busy}>
      <legend>Find references</legend>
      <label>
        Title queries, one per line
        <textarea
          value={queries}
          onChange={(event) => setQueries(event.target.value)}
        />
      </label>
      <IconKey
        keyRef={findRef}
        label="Find"
        onClick={() =>
          void perform(() =>
            passwordWorkflowFind(
              queries
                .split(/\n/)
                .map((query) => query.trim())
                .filter(Boolean),
            ),
          )
        }
      >
        <IconSecret size={18} />
      </IconKey>
      <IconKey
        keyRef={inventoryRef}
        label="Inventory"
        onClick={() => void perform(passwordWorkflowInventory)}
      >
        <IconSecret size={18} />
      </IconKey>
      <IconKey
        keyRef={auditRef}
        label="Audit organization"
        onClick={() => void perform(passwordWorkflowAudit)}
      >
        <IconSecret size={18} />
      </IconKey>
    </fieldset>
  );
}
type CheckedWorkflowOutput = { value: string; check: () => void };
function readableWorkflowOutput(output: CheckedWorkflowOutput | null): string {
  if (!output) return "";
  try {
    output.check();
    return output.value;
  } catch {
    return "";
  }
}
function pinWorkflowOwner(tomb: string): () => void {
  const owner = pinSecurityOwner(tomb);
  const root = pinTombAuthority(tomb);
  return () => {
    owner();
    root();
  };
}
export function PasswordWorkflowsPanel({
  action = "",
}: { action?: string } = {}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      !["create", "compare", "update", "read", "env-resolve"].includes(action)
    )
      return;
    const target = panelRef.current?.querySelector<HTMLElement>(
      `[data-workflow-action="${action}"]`,
    );
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  }, [action]);
  const vault = useVault();
  const [result, setResult] = useState<CheckedWorkflowOutput | null>(null);
  const [error, setError] = useState<CheckedWorkflowOutput | null>(null);
  const [busy, setBusy] = useState(false);
  async function perform(
    operation: (check: () => void) => Promise<WorkflowResult>,
  ) {
    setBusy(true);
    setError(null);
    setResult(null);
    let check: (() => void) | undefined;
    try {
      check = pinWorkflowOwner(vault.tomb);
      const value = await operation(check);
      check();
      setResult({ value: JSON.stringify(value, null, 2), check });
    } catch (caught) {
      if (check) {
        try {
          check();
          setError({
            value:
              caught instanceof Error ? caught.message : "Workflow failed.",
            check,
          });
        } catch {
          /* A successor owner never inherits this operation's result or notice. */
        }
      }
    } finally {
      setBusy(false);
    }
  }
  if (
    vault.status !== "unlocked" ||
    vault.awaitingSecondStep ||
    vault.guest ||
    vault.decoy ||
    isRealAuthorityBlocked()
  )
    return <p>Unlock the vault to use password workflows.</p>;
  const visibleResult = readableWorkflowOutput(result);
  const visibleError = readableWorkflowOutput(error);
  return (
    <div ref={panelRef} className="sheet__body password-workflows">
      <p>
        Find and save credentials in this vault. References use os:// and
        contain no secret values. 1Password op:// workflows and process
        execution use the native CLI.
      </p>
      <DiscoveryWorkflow busy={busy} perform={perform} />
      <TemplateWorkflow busy={busy} perform={perform} />
      <ReadWorkflow busy={busy} perform={perform} />
      <CredentialWorkflow busy={busy} perform={perform} />
      <PasswordWorkflow busy={busy} perform={perform} items={vault.items} />
      <FailureNotice
        id="vault:password-workflows"
        title="Password workflows"
        message={visibleError}
      />
      {visibleResult ? (
        <pre
          aria-label="Workflow result"
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {visibleResult}
        </pre>
      ) : null}
    </div>
  );
}
function PasswordWorkflowsSheet({ onClose }: { onClose: () => void }) {
  const [params] = useSearchParams();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const support = useContext(SupportContext);
  const tutorialActive = useSyncExternalStore(
    useCallback(
      (changed: () => void) => support?.subscribe(changed) ?? (() => {}),
      [support],
    ),
    () => Boolean(support?.view().guide?.tour),
  );
  // The tutorial card owns focus while walking this sheet. The modal resumes
  // its normal initial focus and keyboard trap when that tour ends.
  useModalFocus(!tutorialActive, ref, closeRef, onClose);
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close password workflows"
        onClick={onClose}
      />
      <div
        ref={ref}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: existing modal focus management owns this sheet
        role="dialog"
        aria-modal="true"
        aria-label="Password workflows"
      >
        <div className="sheet__head">
          <h2>Password workflows</h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <PasswordWorkflowsPanel action={params.get("workflowAction") ?? ""} />
      </div>
    </div>
  );
}
function useWorkflowFlow() {
  const [params, setParams] = useSearchParams();
  const [localOpen, setOpen] = useState(false);
  const open = localOpen || params.get("workflow") === "password";
  const close = useCallback(() => {
    setOpen(false);
    if (params.get("workflow") === "password") {
      const next = new URLSearchParams(params);
      next.delete("workflow");
      next.delete("workflowAction");
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  const show = useCallback(() => {
    const next = new URLSearchParams(params);
    next.set("workflow", "password");
    setParams(next, { replace: true });
    setOpen(true);
  }, [params, setParams]);
  return {
    show,
    element: open ? <PasswordWorkflowsSheet onClose={close} /> : null,
  };
}
export function PasswordWorkflowsKey() {
  const guideRef = useGuideTarget<HTMLButtonElement>("vault.workflow.open");
  const flow = useWorkflowFlow();
  return (
    <>
      <IconKey keyRef={guideRef} label="Password workflows" onClick={flow.show}>
        <IconSecret size={15} />
      </IconKey>
      {flow.element}
    </>
  );
}
export function PasswordWorkflowsEntry() {
  const flow = useWorkflowFlow();
  useAddEntry({
    id: "password-workflows",
    label: "Password workflows",
    order: 30,
    run: flow.show,
  });
  return flow.element;
}
