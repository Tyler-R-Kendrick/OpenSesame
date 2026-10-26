/** Core storage, input, and shell infrastructure classification. */
import { core, each, shared } from "./classification-rule.js";

const CORE_INFRA = [
  "kv",
  "web-push-ledger", // ids the core worker controller retires when push goes
  "at-rest/", // every stored value's seal and the device key (ADR 0149)
  "vfs",
  "vault-credential-custody",
  "vault-credential-metadata.test",
  "projects",
  "vaults",
  // Glyphs for vaults, people and organizations belong to the shell prompt (ADR 0165).
  "glyph",
  "last-vault",
  "theme",
  "focus",
  "use-focus-after",
  "gestures",
  "gesture-runtime",
  "gesture-motion",
  "use-gestures",
  "use-claimed-drags",
  "tab-swipe",
  "gesture-help",
  "pane-trail",
  "use-narrow",
  "vault-list-path",
  // `?f=login` is the retired name of `?f=account` (ADR 0172): the vault list and rail read it.
  "vault-filter-slug",
  "modal-focus",
  "strip",
  "scroll-panel",
  "hash-target",
  "pane-escape",
  "tree-motion",
  "page-to-tree",
  "listing-page",
  // Tray history sealed at rest, and the boot that installs it (ADR 0163).
  "notice-tray-persist",
  "tray-boot",
  "use-online",
  "use-configured",
  // A press that must count once, however fast it is pressed twice.
  "use-once",
  "use-settings",
  "use-install",
  "identifier",
  "probe-failure",
  "opener-policy",
  "bounded-response",
  // A lazy chunk a newer deploy replaced, told as a stale page (ADR 0188).
  "chunk-load",
  "urls",
  "agent-page-dump",
  "local-network-fetch",
  // Browser file operations shared by core exports, settings and intake.
  "file-system",
  "wake-lock",
  // Platform socket constructors confer no policy grant; callers own admission.
  "direct-sockets",
  // Vault boot, duress and the proxy settings surface share sealed decoy records.
  "honey-tokens",
  // Core SaveRequestScreen validates a site-authored payload before vault review.
  "save-request",
  "queue",
  "pact",
  // Playwright harness clock shared by CipherDial, VaultDoors, CipherWordmark.
  "injected-clock",
  "unlock-ceremony-store",
  "unlock-ceremony-arm",
  "__tests__/",
  "__snapshots__/",
];

export const CORE_INFRA_RULES = [
  ...each("src/lib/", CORE_INFRA, (p) =>
    core(p, null, "storage, focus, theme and shell infrastructure"),
  ),
  shared(
    "src/test-support/lock-manager.ts",
    "test-only Web Locks double with independent named queues",
  ),
];
