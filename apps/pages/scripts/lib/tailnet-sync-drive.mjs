import { spawn } from "node:child_process";

/** The tailnet sync verifier's throwaway drive daemon, owned by its caller. */
export function startSyncDrive({ binary, port, operator, origin, slots }) {
  const daemon = spawn(
    binary,
    ["daemon", "run", "--listen", `127.0.0.1:${port}`],
    {
      env: {
        ...process.env,
        OPENSESAME_OPERATOR_TOKEN: operator,
        OPENSESAME_CORS_ORIGINS: origin,
        OPENSESAME_VAULT_DRIVE_DIR: slots,
        OPENSESAME_DAEMON_NETWORK_BRIDGE: "0",
        OPENSESAME_ENV: "development",
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  return daemon;
}
