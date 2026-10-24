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
  "queue",
  "pact",
  // Playwright harness clock shared by CipherDial, VaultDoors, CipherWordmark.
  "injected-clock",
  "unlock-ceremony-store",
  "unlock-ceremony-arm",
  "__tests__/",
  "__snapshots__/",
];

/** What the installed app hands the page on boot (`main.tsx` reads each). */
const INSTALLED_APP = [
  "launch-intake", // a file opened through the manifest's File Handling
  "share-target", // the service worker's private Web Share Target hand-off
  "share-target-intake",
  "pwa-refresh", // reload once when a newer service worker takes control
];

/** The person's own files: the browser's save and open pickers, kept awake. */
const PERSON_FILES = ["file-system", "wake-lock"];

export const CORE_INFRA_RULES = [
  ...each("src/lib/", CORE_INFRA, (p) =>
    core(p, null, "storage, focus, theme and shell infrastructure"),
  ),
  ...each("src/lib/", INSTALLED_APP, (p) =>
    core(p, "install.pwa", "installed-app launch, share and update hand-offs"),
  ),
  ...each("src/lib/", PERSON_FILES, (p) =>
    core(
      p,
      null,
      "save/open pickers and a wake lock core export, import, settings and vault fields share",
    ),
  ),
  core(
    "src/lib/honey-tokens",
    null,
    "honey tokens the core vault store seals and boot reads; no provider, no network",
  ),
  core(
    "src/lib/save-request",
    null,
    "the request a site hands the core /save review screen; nothing is saved before review",
  ),
  shared(
    "src/lib/direct-sockets",
    "IWA-only platform adapter over TCPSocket/TCPServerSocket/UDPSocket; docs/design/iwa.md names several intended consumers (terminal transports, printers/IoT, mDNS discovery, pairing listeners), so it is infrastructure several capabilities will import and owns no feature itself; nothing imports it today",
  ),
];
