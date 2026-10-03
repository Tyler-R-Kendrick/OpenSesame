type Host = Readonly<{
  reason?: string | undefined;
  fixUrl?: string | null | undefined;
}>;

/** This origin cannot run a passkey ceremony: say why, and the road that fixes it. */
export function PasskeyHostNote({ host }: { host: Host }) {
  return (
    <output className="note note--warn">
      <span>
        {host.reason}
        {host.fixUrl ? (
          <>
            {" "}
            {/* A button, same as the Settings twin's healPasskeyHost
                — the unlock screen was the one auth surface still
                repairing its environment through a raw anchor. */}
            <button
              type="button"
              className="unlock__switch"
              onClick={() => window.location.assign(host.fixUrl ?? "")}
            >
              Continue on localhost
            </button>{" "}
            (same vault data), then unlock with passkey.
          </>
        ) : (
          <> Open this app on a DNS hostname, then try again.</>
        )}
      </span>
    </output>
  );
}
