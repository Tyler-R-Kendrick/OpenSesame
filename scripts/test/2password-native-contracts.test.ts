import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
const execute = promisify(execFile);
const PreparedArtifact = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const PreparedArtifacts = z.object({
  cli: PreparedArtifact,
  connector: PreparedArtifact,
  production: PreparedArtifact,
});
async function nativeContract(name: string, packageName = "opensesame-cli") {
  const artifacts = PreparedArtifacts.parse(
    JSON.parse(
      await readFile(
        join(process.cwd(), "work/2password-native-artifacts.json"),
        "utf8",
      ),
    ),
  );
  const artifact =
    packageName === "opensesame-cli" ? artifacts.cli : artifacts.connector;
  const digest = createHash("sha256")
    .update(await readFile(artifact.path))
    .digest("hex");
  expect(digest).toBe(artifact.sha256);
  const result = await execute(
    artifact.path,
    [name, "--exact", "--nocapture"],
    {
      timeout: 180000,
      maxBuffer: 1048576,
    },
  );
  expect(result.stdout).toContain("1 passed; 0 failed");
  expect(result.stdout).toContain(`${name} ... ok`);
}
describe("2password native executor contracts", () => {
  it(
    "removes every reserved startup key before helper authentication",
    async () =>
      nativeContract(
        "password_agent::io::tests::every_reserved_startup_key_is_removed_before_helper_authentication",
      ),
    180000,
  );
  it(
    "rejects startup assignments and templates before credentials",
    async () =>
      nativeContract(
        "password_agent::io::tests::shared_startup_assignments_and_templates_are_rejected_before_credentials",
      ),
    180000,
  );
  it(
    "constructs exact UTF8 Windows clipboard command policy",
    async () =>
      nativeContract(
        "password_agent::io::tests::windows_clipboard_command_uses_utf8_exact_output_without_profiles",
      ),
    180000,
  );
  it(
    "bounds blocked native local IO and drops late private results",
    async () =>
      nativeContract(
        "password_agent::request::tests::native_deadline_bounds_blocked_local_io_and_drops_late_private_results",
      ),
    180000,
  );

  it("enforces bounded execution redirect rejection and no retries", async () => {
    await nativeContract(
      "password_agent::request::tests::private_requests_reject_redirects_oversize_and_send_failures_without_retry",
    );
    await nativeContract(
      "password_agent::request::tests::bounded_private_stalls_preserve_claim_state_and_drop_released_results",
    );
  }, 180000);
  it(
    "pins actual transport SNI and verifies TLS without reconnecting",
    async () =>
      nativeContract(
        "password_agent::request::tests::native_transport_pins_socket_preserves_sni_verifies_tls_and_never_retries",
      ),
    180000,
  );

  it(
    "rejects unsafe request shapes and all special DNS answers",
    async () =>
      nativeContract(
        "password_agent::request::tests::destination_and_public_dns_are_required_before_credential",
        "opensesame-connector-host",
      ),
    180000,
  );
  it(
    "keeps request receipt origin-only and normalizes credential header bytes",
    async () =>
      nativeContract(
        "password_agent::request::tests::private_response_receipt_omits_paths_queries_and_plaintext",
        "opensesame-connector-host",
      ),
    180000,
  );
  it(
    "bounds lease policy and denies mismatched authority",
    async () =>
      nativeContract(
        "password_agent::lease::tests::lease_bounds_and_exact_authority_fail_closed",
        "opensesame-connector-host",
      ),
    180000,
  );

  it(
    "pins public DNS claims before private read and withholds response",
    async () =>
      nativeContract(
        "password_agent::request::tests::private_requests_pin_public_dns_claim_before_read_and_withhold_response",
      ),
    180000,
  );
  it(
    "denies mixed DNS and burns failed or rotated credentials",
    async () =>
      nativeContract(
        "password_agent::request::tests::mixed_dns_denies_before_inspection_and_read_failures_or_rotation_burn_claims",
      ),
    180000,
  );
  it(
    "persists atomic versioned expiring revocable leases",
    async () =>
      nativeContract(
        "password_agent::lease_store::tests::atomic_leases_allow_one_claim_and_enforce_version_revoke_expiry",
      ),
    180000,
  );
});
