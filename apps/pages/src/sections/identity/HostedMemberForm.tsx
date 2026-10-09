import { useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
export function MemberForm({
  online,
  busy,
  onAdd,
  onCancel,
}: {
  online: boolean;
  busy: boolean;
  onAdd: (id: string, role: string) => void;
  onCancel: () => void;
}) {
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState("member");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (principal.trim()) onAdd(principal.trim(), role);
      }}
    >
      <div className="field">
        <label htmlFor="identity-member-principal">Principal id</label>
        <input
          id="identity-member-principal"
          value={principal}
          disabled={busy}
          onChange={(event) => setPrincipal(event.target.value)}
          required
          spellCheck={false}
        />
      </div>
      <div className="field">
        <label htmlFor="identity-member-role">Role</label>
        <select
          id="identity-member-role"
          value={role}
          disabled={busy}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
          <option value="owner">owner</option>
        </select>
      </div>
      <FormCommit
        label="Add member"
        disabled={busy || !online || !principal.trim()}
      >
        <IconKey label="Cancel" disabled={busy} onClick={onCancel}>
          <IconX size={16} />
        </IconKey>
      </FormCommit>
    </form>
  );
}
