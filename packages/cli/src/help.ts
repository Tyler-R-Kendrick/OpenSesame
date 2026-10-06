export function helpText(): string {
  return `opensesame-id — OpenSesame identity CLI (alias: opensesame-identity)

Commands:
  login [--device|--loopback|--no-browser|--anonymous] [--qr|--no-qr]
                  --anonymous (alias --guest): start as a provisional guest;
                  link an identity later to keep the same principal id
  auth status
  logout
  whoami
  project create --temporary [--name <name>]
  claim poll <claimId> --token <osc_clm_…>   (or OPENSESAME_CLAIM_TOKEN)
  agent init --anonymous [--name <name>]
  host health [--host <url>]   Host API (:8787) via api-client
  host discover [--host <url>] Host PRM / readiness discovery
  vault verify <file>          Open a vault export or offline backup
                               (master password from the terminal only)
  vault ls <file>              List that file: path and kind, never values
  vault new <kind> --name <n>  Create an account, secret, note, or card
  vault list                   List the local vault: id, kind, and name
  vault import <file>          Merge a sealed export into the local vault
  vault export [--out <file>]  Write a sealed export of the local vault
  vault set|edit <item>        Change --name, --username, or --secret
  vault copy <item> [--field secret|username]
                               Copy a field to the clipboard, never print it
  vault share <item>           Share a secret once; prints the link and code
  vault sync [--pair <code>]   Sync with a tailnet drive (ADR 0144); with no
                               vault here, set it up from the drive first
  vault retired-credentials status|clear|remove <id>
  vault retired-credentials enroll --acknowledge-password-verifier-risk
                               [--response reject|synthetic_decoy]
                               Current/retired passwords: terminal only
  security canary status|clear-events|remove <artifact-id>
  security canary retire <issuer-record-ref> (actual configured issuer only)
  security canary create --kind <kind> --output <owner-only-file>
  security canary export-mcp --output <owner-only-file>
  security receiver configure <pairing-file> --confirm-destination
  security receiver status|test|enable|disable|remove
  canary install --config <private-export-file> --trust-configuration
  canary events|uninstall --config <private-export-file>
  canary serve --config <owner-only-file>
                               Synthetic stdio validator; no real vault authority
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
