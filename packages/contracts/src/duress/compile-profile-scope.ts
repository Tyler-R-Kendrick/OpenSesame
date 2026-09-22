import { diag, has } from "./compiler-util.js";
import type { CompilerCatalog, CompilerDiagnostic } from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

export function validateProfileScope(
  profile: PolicyProfile,
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
  base: string,
): void {
  const scope = profile.scope;

  if (!has(catalog.ownerPrincipalRefs, scope.ownerPrincipalRef)) {
    diagnostics.push(
      diag(
        "scope_mismatch",
        `${base}.scope.ownerPrincipalRef`,
        "Owner not in catalog.",
      ),
    );
  }
  if (!has(catalog.vaultRefs, scope.vaultRef)) {
    diagnostics.push(
      diag("scope_mismatch", `${base}.scope.vaultRef`, "Vault not in catalog."),
    );
  }
  if (!has(catalog.deviceBindingRefs, scope.deviceBindingRef)) {
    diagnostics.push(
      diag(
        "scope_mismatch",
        `${base}.scope.deviceBindingRef`,
        "Device binding not in catalog.",
      ),
    );
  }

  const retired = catalog.retiredDeviceBindingRefs ?? [];
  if (retired.includes(scope.deviceBindingRef)) {
    diagnostics.push(
      diag(
        "retired_device",
        `${base}.scope.deviceBindingRef`,
        "Device binding is retired.",
      ),
    );
  }
  if (
    scope.organizationRef !== null &&
    !has(catalog.organizationRefs, scope.organizationRef)
  ) {
    diagnostics.push(
      diag(
        "scope_mismatch",
        `${base}.scope.organizationRef`,
        "Organization not in catalog.",
      ),
    );
  }
  for (const c of scope.compartmentRefs) {
    if (!has(catalog.compartmentRefs, c)) {
      diagnostics.push(
        diag(
          "scope_mismatch",
          `${base}.scope.compartmentRefs`,
          `Unknown compartment ${c}.`,
        ),
      );
    }
  }
}
