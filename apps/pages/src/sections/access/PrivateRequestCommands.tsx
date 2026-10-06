import type { nativeRequestCommands } from "@opensesame/app-core/lib/password-agent/native-handoff.js";
export function PrivateRequestCommands({
  commands,
}: { commands: ReturnType<typeof nativeRequestCommands> | undefined }) {
  return commands ? (
    <div
      aria-label="Native request commands"
      style={{ overflowWrap: "anywhere" }}
    >
      <p>Destination: {commands.destination}</p>
      <p>
        Exact destination fingerprint: <code>{commands.fingerprint}</code>
      </p>
      <h3>Human approval</h3>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {commands.approve}
      </pre>
      {commands.request ? (
        <>
          <h3>Consume approved lease</h3>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {commands.request}
          </pre>
          <h3>Inspect or revoke</h3>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {commands.status}
            {"\n"}
            {commands.revoke}
          </pre>
        </>
      ) : (
        <p>
          Paste the returned lease ID above to prepare the request, status and
          revocation commands.
        </p>
      )}
    </div>
  ) : null;
}
