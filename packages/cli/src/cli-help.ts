export function helpText(): string {
  return `opensesame-id — OpenSesame identity CLI (alias: opensesame-identity)

Commands:
  security canary serve --pairing <file> --state <directory>
                               Run the owner-paired loopback canary receiver
  find <query...> [--vault <vault>] [--account <account>]
  inventory | audit           Metadata and organization checks, never values
  create api-credential --title <title> --vault <vault> --stdin|--clipboard
  password <item> --vault <vault> --stdin|--clipboard [--apply]
  reveal <op://reference|os://reference> [--reveal] [--desktop]
                               Human-only plaintext stdout (TTY, no agent context)
  run [--env NAME=<ref>...] [--mount NAME=<ref>...] [--agent-proxy --paths NAME=/p --methods NAME=GET] [--grant <run-grant-id>] -- <command...>
                               <ref>: op:// or os:// vault/item/field; --mount sets NAME to a private temp file holding the secret; --agent-proxy brokers os:// connections items (native CLI + plugin; this CLI fails closed)
  env write <file> <NAME=op://reference...>
  env run <file> -- <command...>
  service-account setup|connect|status|recover|forget
  request <https-url> --secret <op://reference> [--lease <id>]
  lease approve <https-url> --secret <ref> --desktop [--expires-in 10m] [--uses 1]
  lease approve-run --env NAME=<ref>... [--mount NAME=<ref>...] [--agent-proxy --paths NAME=/p --methods NAME=GET] --desktop [--expires-in 10m] [--uses 1]  (reusable grant for that exact run set; consume with run --grant <id>)
  lease list|status <id>|revoke <id>|run-list|run-status <id>|run-revoke <id>
  doctor                      Inspect provider setup without authentication
  login [--device|--loopback|--no-browser|--anonymous] [--qr|--no-qr]
                  --anonymous (alias --guest): start as a provisional guest;
                  link an identity later to keep the same principal id
  auth status
  logout
  whoami
  project create --temporary [--name <name>]
  claim poll <claimId> --token <osc_clm_…>   (or OPENSESAME_CLAIM_TOKEN)
  agent init --anonymous [--name <name>]
  password-reset configure|run|resume|reconcile --config <file>
                               Approved recipe, agent vault and live human grants
  host health [--host <url>]   Host API (:8787) via api-client
  host discover [--host <url>] Host PRM / readiness discovery
  password-reset run|resume|reconcile --config <file>
                               [--run-id <id> --item <id> --origin <url>
                                --recipe <file> --grant <file> --host <url>
                                --runtime <adapter-file> --model <id>]
                               Durable reset; pepper is read from the terminal only
  vault verify <file>          Open a vault export or offline backup
                               (master password from the terminal only)
  vault ls <file>              List that file: path and kind, never values
  vault new <kind> --name <n>  Create an account, secret, note, or card
  vault list                   List the local vault: id, kind, and name
  vault canary pairing|inspect|enroll|remove|export
                               --receiver <loopback-url> --service-id <id> --origin <url> --port <port>; enroll requires --label <label> --artifact-kind mcp-config|connection-reference --owner-consent; optional --retention-days 1..90, --out <new-file>
  vault retired inspect|enroll|remove|clear-stale|clear-events
                               Fresh owner authentication; secrets read only from terminal. enroll requires --response reject|synthetic_decoy; optional --retention-days 1..90, --primary password|pin, --factor totp|email|sms|recovery
  vault import <file>          Merge a sealed export into the local vault
  vault export [--out <file>]  Write a sealed export of the local vault
  vault set|edit <item>        Change --name, --username, or --secret
  vault copy <item> [--field secret|username]
                               Copy a field to the clipboard, never print it
  vault share <item>           Share a secret once; prints the link and code
  vault sync [--pair <code>]   Sync with a tailnet drive (ADR 0144); with no
                               vault here, set it up from the drive first
  session [<link>] list        Join a live session as a device (ADR 0196), wait
                               for the host's approval, list what it granted
  session [<link>] invoke <connection> <operation> [--input key=value]...
                               Use one granted connection through the host's tab
                               options: --code CODE, --name LABEL, --connection
                               ID (a hint), --timeout SECONDS (default 900)
                               The link and code are bearers: set
                               OPENSESAME_LIVE_LINK / OPENSESAME_LIVE_CODE
  mcp host|client              Serve the host- or client-facing MCP tools
                               (stdio; OPENSESAME_MCP_TRANSPORT=http for HTTP)

Global:
  --json          Machine-readable output (secrets redacted)
  --issuer <url>  OIDC issuer (default OPENSESAME_ISSUER or http://127.0.0.1:8788)
  --api <url>     Identity control plane API base
  --client-id <id>
  --qr / --no-qr  Device login: print a terminal QR (default: on for TTY)
`;
}
