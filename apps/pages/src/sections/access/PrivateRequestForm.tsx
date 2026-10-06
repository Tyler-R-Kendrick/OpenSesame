export function PrivateRequestForm({
  onPrepare,
}: { onPrepare: (data: FormData) => void }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onPrepare(new FormData(event.currentTarget));
      }}
    >
      <label>
        Native CLI
        <select name="executable" defaultValue="opensesame">
          <option value="opensesame">opensesame</option>
          <option value="opensesame-id">opensesame-id</option>
        </select>
      </label>
      <label>
        Terminal
        <select name="shell" defaultValue="posix">
          <option value="posix">Bash / Zsh</option>
          <option value="powershell">PowerShell</option>
        </select>
      </label>
      <label>
        Exact HTTPS destination
        <input
          name="url"
          type="url"
          required
          placeholder="https://api.example.com/v1/me"
        />
      </label>
      <label>
        Credential reference
        <input
          name="reference"
          required
          placeholder="op://Automation/Example/credential"
          autoComplete="off"
        />
      </label>
      <label>
        Credential header
        <select name="header" defaultValue="Authorization">
          <option>Authorization</option>
          <option>X-API-Key</option>
        </select>
      </label>
      <label>
        Header prefix
        <input name="prefix" defaultValue="Bearer " />
      </label>
      <label>
        Lifetime
        <select name="expiresIn" defaultValue="10m">
          <option value="1m">1 minute</option>
          <option value="10m">10 minutes</option>
          <option value="1h">1 hour</option>
        </select>
      </label>
      <label>
        Use budget
        <input
          name="uses"
          type="number"
          min="1"
          max="10"
          defaultValue="1"
          required
        />
      </label>
      <label>
        Existing lease ID (optional)
        <input name="leaseId" autoComplete="off" />
      </label>
      <button type="submit" className="btn">
        Prepare commands
      </button>
    </form>
  );
}
