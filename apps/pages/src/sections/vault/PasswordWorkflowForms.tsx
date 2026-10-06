import {
  envAssignments,
  parseAssignment,
  renderEnv,
} from "@opensesame/app-core/lib/password-agent/env.js";
import {
  comparePrivatePassword,
  createPrivateCredential,
  resolveLocalEnvTemplate,
  resolveLocalReference,
} from "@opensesame/app-core/lib/vault/password-workflows.js";
import {
  type AccountItem,
  type VaultItem,
  producePassword,
} from "@opensesame/vault-core";
import { useId, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconDownload, IconSecret } from "../../components/Icons.js";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { methodTitle } from "./MethodPicker.js";
import type { PerformWorkflow } from "./PasswordWorkflows.js";
type Props = { busy: boolean; perform: PerformWorkflow };
export function CredentialWorkflow({ busy, perform }: Props) {
  const privateRef = useGuideTarget<HTMLFieldSetElement>(
    "vault.workflow.private",
  );
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [value, setValue] = useState("");
  return (
    <fieldset ref={privateRef} disabled={busy}>
      <legend>Create API credential</legend>
      <label>
        Title
        <input
          data-workflow-action="create"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        Private credential
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <label>
        Website URL (optional)
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label>
        Operational notes (optional)
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <IconKey
        label="Create and verify"
        onClick={() => {
          const privateValue = value;
          setValue("");
          void perform(() =>
            createPrivateCredential(title, privateValue, { url, notes }),
          );
        }}
      >
        <IconCheck size={18} />
      </IconKey>
    </fieldset>
  );
}
export function PasswordWorkflow({
  busy,
  perform,
  items,
}: Props & { items: readonly VaultItem[] }) {
  const loginId = useId();
  const [login, setLogin] = useState("");
  const [method, setMethod] = useState("");
  const [password, setPassword] = useState("");
  const account = items.find(
    (item): item is AccountItem => item.kind === "account" && item.id === login,
  );
  const methods =
    account?.methods.filter(
      (entry) => entry.type === "password" && !requiresPrivateInput(entry),
    ) ?? [];
  const selectedMethod =
    method || (methods.length === 1 ? methods[0]?.id : undefined);
  function run(apply: boolean) {
    const value = password;
    setPassword("");
    void perform(() =>
      comparePrivatePassword(login, value, apply, selectedMethod),
    );
  }
  return (
    <fieldset disabled={busy}>
      <legend>Compare or update account password</legend>
      <label htmlFor={loginId}>Account</label>
      <select
        id={loginId}
        value={login}
        onChange={(event) => {
          setLogin(event.target.value);
          setMethod("");
          setPassword("");
        }}
      >
        <option value="">Choose an account</option>
        {items
          .filter((item) => item.kind === "account" && item.deletedAt === null)
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
      </select>
      {account ? (
        <PasswordMethodSelection
          account={account}
          selected={selectedMethod ?? ""}
          onChange={(id) => {
            setMethod(id);
            setPassword("");
          }}
        />
      ) : null}
      <label>
        Private password
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <IconKey
        data-workflow-action="compare"
        label="Compare"
        onClick={() => run(false)}
      >
        <IconSecret size={18} />
      </IconKey>
      <IconKey
        data-workflow-action="update"
        label="Update and verify"
        onClick={() => run(true)}
      >
        <IconCheck size={18} />
      </IconKey>
    </fieldset>
  );
}
function PasswordMethodSelection({
  account,
  selected,
  onChange,
}: { account: AccountItem; selected: string; onChange: (id: string) => void }) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>Password method</label>
      <select
        id={id}
        value={selected}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a password method</option>
        {account.methods
          .filter((method) => method.type === "password")
          .map((method) => (
            <option
              key={method.id}
              value={method.id}
              disabled={requiresPrivateInput(method)}
            >
              {methodTitle(account.methods, method)}
              {requiresPrivateInput(method) ? " (private input required)" : ""}
            </option>
          ))}
      </select>
    </>
  );
}
export function TemplateWorkflow({ busy, perform }: Props) {
  const templateRef = useGuideTarget<HTMLButtonElement>(
    "vault.workflow.template",
  );
  const [assignments, setAssignments] = useState("");
  const [allowPlaintext, setAllowPlaintext] = useState(false);
  async function saveTemplate() {
    const rows = assignments
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseAssignment);
    const text = renderEnv(rows);
    downloadSeams.save(".env.tpl", text, "text/plain");
    return { saved: ".env.tpl", references: envAssignments(text).length };
  }
  async function resolveTemplate() {
    if (!allowPlaintext)
      throw new Error(
        "Confirm that the downloaded file will contain plaintext credentials.",
      );
    const resolved = await resolveLocalEnvTemplate(assignments);
    downloadSeams.save(".env", resolved.content, "text/plain");
    return { saved: ".env", references: resolved.count };
  }
  return (
    <fieldset disabled={busy}>
      <legend>Reference env template</legend>
      <label>
        Assignments, one NAME=reference per line
        <textarea
          value={assignments}
          onChange={(event) => setAssignments(event.target.value)}
          placeholder="API_KEY=os://personal/item/value"
        />
      </label>
      <IconKey
        keyRef={templateRef}
        label="Save reference template"
        onClick={() => void perform(saveTemplate)}
      >
        <IconDownload size={18} />
      </IconKey>
      <label>
        <input
          type="checkbox"
          data-workflow-action="env-resolve"
          checked={allowPlaintext}
          onChange={(event) => setAllowPlaintext(event.target.checked)}
        />
        I want a plaintext credential file on this device.
      </label>
      <IconKey
        label="Resolve and download plaintext env"
        disabled={!allowPlaintext}
        onClick={() => void perform(resolveTemplate)}
      >
        <IconDownload size={18} />
      </IconKey>
      <p>
        The browser cannot set file permissions or start a process. Keep
        plaintext downloads private. Run op:// templates with the native CLI.
      </p>
    </fieldset>
  );
}

export function ReadWorkflow({ busy, perform }: Props) {
  const readRef = useGuideTarget<HTMLButtonElement>("vault.workflow.read");
  const [reference, setReference] = useState("");
  const [allowPlaintext, setAllowPlaintext] = useState(false);
  async function read() {
    if (!allowPlaintext) throw new Error("Confirm plaintext download first.");
    const value = await resolveLocalReference(reference);
    downloadSeams.save("credential.txt", value, "text/plain");
    return { saved: "credential.txt" };
  }
  return (
    <fieldset disabled={busy}>
      <legend>Read one local reference</legend>
      <label>
        Local secret reference
        <input
          data-workflow-action="read"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          placeholder="os://personal/item/value"
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={allowPlaintext}
          onChange={(event) => setAllowPlaintext(event.target.checked)}
        />
        I want this credential in a plaintext file.
      </label>
      <IconKey
        keyRef={readRef}
        label="Read and download plaintext credential"
        disabled={!allowPlaintext}
        onClick={() => void perform(read)}
      >
        <IconDownload size={18} />
      </IconKey>
    </fieldset>
  );
}

function requiresPrivateInput(
  method: Parameters<typeof producePassword>[0],
): boolean {
  const produced = producePassword(method);
  return produced.status === "slotted" || produced.status === "legacy";
}
