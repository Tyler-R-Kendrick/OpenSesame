/** Forbidden combinations, independent of file layout and source loading. */
import { contractFor } from "./exposure-contracts.mjs";
import { LOCAL_VAULT_CONTROLS } from "./exposure-local-vault.mjs";
import { NATIVE_PROVIDER_CONTROLS } from "./exposure-native-provider.mjs";
const has = (row, ...controls) =>
  controls.every((control) => row.controls.includes(control));
const artifact = (row, value) => row.artifacts.includes(value);
const untrusted = (row) =>
  !["device-owner", "authorized-recipient"].includes(row.observer);

function safeBudget(value) {
  return (
    value &&
    value.storage === "durable" &&
    value.admission === "before-verification" &&
    value.atomicity === "atomic" &&
    value.eviction === "expired-only" &&
    value.sharing === "across-routes" &&
    !["activation", "ip", "global"].includes(value.scope)
  );
}

const online = (row) => row.kind === "online" || artifact(row, "guess-oracle");
const codeGate = (row) =>
  row.kind === "offline" &&
  row.verification === "code-aead" &&
  row.entropyBits >= 80 &&
  has(row, "code-derived-aead", "bounded-kdf", "cryptographic-random");
const serverGate = (row) =>
  row.verification === "server" &&
  has(row, "mandatory-proof") &&
  row.enforcement === "authoritative";

function weakerBudget(row) {
  const floor = contractFor(row.id)?.budget;
  return (
    floor &&
    (!row.budget ||
      row.budget.limit > floor.maxAttempts ||
      row.budget.windowSeconds < floor.minWindowSeconds)
  );
}
const RULES = [
  [
    "EM-SECRET-PROJECTION",
    "untrusted observers must not receive private material or locally testable OTP verifiers",
    (row) =>
      untrusted(row) &&
      row.artifacts.some((value) =>
        ["private-key", "raw-secret", "otp-seed", "code-verifier"].includes(
          value,
        ),
      ),
  ],
  [
    "EM-EXPORT",
    "credential export requires an explicit grant, recipient binding and step-up",
    (row) =>
      row.observer === "authorized-recipient" &&
      row.artifacts.some((value) =>
        [
          "raw-secret",
          "private-key",
          "otp-seed",
          "code-verifier",
          "payload-key",
        ].includes(value),
      ) &&
      !has(row, "explicit-export-grant", "recipient-bound", "step-up"),
  ],
  [
    "EM-ONLINE-PROOF",
    "online proof must be mandatory at the enforcing server authority",
    (row) => online(row) && !serverGate(row),
  ],
  [
    "EM-GUESS-BUDGET",
    "guess oracle requires atomic durable admission shared by its owner and alternate routes; CAPTCHA/IP/global counters are supplementary",
    (row) => online(row) && !safeBudget(row.budget),
  ],
  [
    "EM-ORACLE-CONTRACT",
    "every guess oracle needs an explicit reviewed owner and budget contract",
    (row) => online(row) && !contractFor(row.id)?.budget,
  ],
  [
    "EM-BUDGET-SCOPE",
    "the verification budget must cover this proof's owner",
    (row) =>
      contractFor(row.id)?.budget &&
      row.budget?.scope !== contractFor(row.id).budget.scope,
  ],
  [
    "EM-BUDGET-STRENGTH",
    "verification budget cannot weaken the reviewed attempt/window bounds",
    weakerBudget,
  ],
  [
    "EM-BUDGET-SOURCE",
    "source partitions are reserved for long EST credentials and require a trusted source bound to the profile",
    (row) =>
      (row.id === "est-password" || row.budget?.scope === "profile-source") &&
      (row.id !== "est-password" ||
        row.minSecretBytes < 16 ||
        !has(row, "trusted-budget-source")),
  ],
  [
    "EM-BUDGET-OWNER",
    "Bitwarden budgets require existing owners and cannot deny unrelated owners through a shared capacity cliff",
    (row) =>
      row.area === "bitwarden" &&
      online(row) &&
      !has(row, "validated-budget-owner", "owner-isolated-capacity"),
  ],
  [
    "EM-PUBLIC-KEYS",
    "public keys require an allowlist projection, never deletion of a private-field list",
    (row) =>
      row.kind === "projection" && !has(row, "public-parameter-allowlist"),
  ],
  [
    "EM-OFFLINE-CODE",
    "portable secret release requires code-bound AEAD, bounded KDF and at least 80 independent random bits",
    (row) => row.kind === "offline" && !codeGate(row),
  ],
  [
    "EM-LIFECYCLE",
    "global lifecycle claims need authoritative state; copied offline data cannot provide them",
    (row) =>
      row.guarantees.length > 0 &&
      (row.enforcement !== "authoritative" || row.kind === "offline"),
  ],
  [
    "EM-LISTENERS",
    "every listener needs exposure classification, explicit bind admission and a joined lifetime",
    (row) =>
      row.kind === "listener" &&
      !has(
        row,
        "all-listeners-classified",
        "explicit-network-bind",
        "joined-listener-lifetime",
      ),
  ],
  [
    "EM-POLICY-OMISSION",
    "omitted fields must preserve required proof policy",
    (row) => row.kind === "policy" && !has(row, "preserve-policy-on-omission"),
  ],
  [
    "EM-ORIGINATING-CLIENT",
    "an ingress leaf cannot substitute for originating-client proof",
    (row) => row.kind === "proof" && !has(row, "originating-client-proof"),
  ],
  [
    "EM-CUSTODY-CONTRACT",
    "custody requires an explicit reviewed contract for its observer and controls",
    (row) => row.kind === "custody" && contractFor(row.id)?.kind !== "custody",
  ],
  [
    "EM-LOCAL-VAULT-CUSTODY",
    "local activation requires original-owner lifetime, synchronous provisional revocation, bounded private IAM and owned single-flight publication",
    (row) =>
      row.id === "local-vault-activation" && !has(row, ...LOCAL_VAULT_CONTROLS),
  ],
  [
    "EM-NATIVE-PROVIDER-CUSTODY",
    "native provider results require the original transport, captured connection revision and current authority before secret reads and after awaited work and revision locks",
    (row) =>
      row.id === "native-provider-custody" &&
      !has(row, ...NATIVE_PROVIDER_CONTROLS),
  ],
  [
    "EM-IMPORT-CUSTODY",
    "untrusted imports require confined paths, bounded reads and pinned credential origins",
    (row) =>
      row.id === "bitwarden-import" &&
      !has(
        row,
        "confined-import-paths",
        "bounded-import-input",
        "pinned-import-origin",
      ),
  ],
  [
    "EM-BOOTSTRAP-TRUST",
    "EST bootstrap proof cannot borrow trust from additional listener anchors",
    (row) =>
      row.id === "est-client-certificate" && !has(row, "exact-bootstrap-trust"),
  ],
  [
    "EM-WEAK-ENROLLMENT",
    "new and stored enrollment passwords require the same minimum floor",
    (row) => row.id === "est-password" && row.minSecretBytes < 16,
  ],
  [
    "EM-BEARER-FIRST",
    "public identifiers cannot authorize code guesses or spend another claim's budget",
    (row) =>
      row.id === "hosted-secret-drop" && !has(row, "bearer-before-budget"),
  ],
];

/** Generic login, possession of a link and network contact can belong to one caller. */
function joinedViolations(group, observer) {
  const visible = untrusted({ observer })
    ? group.filter(untrusted)
    : group.filter(
        (row) => row.observer === observer || row.observer === "public",
      );
  const unguardedKey = visible.some(
    (row) => artifact(row, "payload-key") && !serverGate(row) && !codeGate(row),
  );
  const offline = visible.some((row) => row.kind === "offline");
  const violations = [];
  for (const row of visible) {
    if (row.guarantees.length > 0 && offline) {
      violations.push({
        surface: row.id,
        rule: "EM-LIFECYCLE",
        reason: `offline data visible to ${observer} prevents global lifecycle guarantees, even from another endpoint`,
      });
    }
    if (
      untrusted({ observer }) &&
      artifact(row, "ciphertext") &&
      unguardedKey &&
      !serverGate(row) &&
      !codeGate(row)
    ) {
      violations.push({
        surface: row.id,
        rule: "EM-KEY-CIPHERTEXT",
        reason: `ciphertext and its key reach ${observer} without an independent release proof`,
      });
    }
  }
  return violations;
}

/** Evaluate both individual boundaries and their combined observer visibility. */
export function exposureViolations(policy) {
  const violations = [];
  const flows = new Map();
  for (const row of policy.surfaces) {
    for (const [rule, reason, violates] of RULES) {
      if (violates(row)) violations.push({ surface: row.id, rule, reason });
    }
    const group = flows.get(row.flow) ?? [];
    group.push(row);
    flows.set(row.flow, group);
  }
  for (const group of flows.values()) {
    const observers = new Set(
      group.filter((row) => !untrusted(row)).map((row) => row.observer),
    );
    if (group.some(untrusted)) observers.add("an untrusted caller");
    for (const observer of observers) {
      violations.push(...joinedViolations(group, observer));
    }
  }
  return violations;
}
