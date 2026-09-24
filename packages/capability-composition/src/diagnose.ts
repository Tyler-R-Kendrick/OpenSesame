/**
 * Diagnostics over runtime documents against a catalog and distribution.
 *
 * The resolver keys its plan by catalog ids, so an id no catalog entry
 * matches can never activate; this pass names such ids so a person sees
 * them instead of a silently ignored line. It also flags a core capability
 * that a policy or selection lists, since core never appears in those sets.
 */
import { indexCatalog } from "./catalog.js";
import { type Diagnostic, diagnostic, pushDiagnostic } from "./diagnostics.js";
import type { ResolveInput } from "./resolve-input.js";
import type { CapabilityDescriptor, CapabilityId } from "./types.js";

type IdSource = Readonly<{ path: string; ids: readonly CapabilityId[] }>;

function policySources(input: ResolveInput): IdSource[] {
  const out: IdSource[] = [];
  const policy = input.instancePolicy;
  if (policy !== null) {
    out.push(
      {
        path: "instancePolicy.capabilities.required",
        ids: policy.capabilities.required,
      },
      {
        path: "instancePolicy.capabilities.optional",
        ids: policy.capabilities.optional,
      },
      {
        path: "instancePolicy.capabilities.prohibited",
        ids: policy.capabilities.prohibited,
      },
    );
  }
  if (input.workspace !== null) {
    out.push({ path: "workspace.prohibited", ids: input.workspace.prohibited });
    if (input.workspace.allow !== null)
      out.push({ path: "workspace.allow", ids: input.workspace.allow });
  }
  return out;
}

function selectionSources(input: ResolveInput): IdSource[] {
  const out: IdSource[] = [];
  const installation = input.installation;
  if (installation !== null) {
    out.push(
      {
        path: "installation.acceptedRequired",
        ids: installation.acceptedRequired,
      },
      {
        path: "installation.selectedOptional",
        ids: installation.selectedOptional,
      },
      {
        path: "installation.chosenAlternatives",
        ids: Object.values(installation.chosenAlternatives),
      },
    );
  }
  if (input.vault !== null)
    out.push({ path: "vault.disabled", ids: input.vault.disabled });
  if (input.receipt !== null) {
    out.push(
      { path: "receipt.roots", ids: input.receipt.roots },
      { path: "receipt.exposure", ids: Object.keys(input.receipt.exposure) },
    );
  }
  return out;
}

function checkIds(
  sources: readonly IdSource[],
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
  diags: Diagnostic[],
): void {
  for (const source of sources) {
    source.ids.forEach((id, i) => {
      const path = `${source.path}[${i}]`;
      const d = index.get(id);
      if (d === undefined) {
        pushDiagnostic(
          diags,
          diagnostic(
            "UNKNOWN_CAPABILITY",
            path,
            `\`${id}\` is not in the catalog and cannot activate`,
          ),
        );
      } else if (
        d.tier === "core" &&
        // An always-on capability may be withdrawn (ADR 0138); only
        // statically linked core, which cannot be, is misplaced there.
        !(
          source.path === "instancePolicy.capabilities.prohibited" &&
          d.moduleIds.length > 0
        )
      ) {
        pushDiagnostic(
          diags,
          diagnostic(
            "CORE_IN_POLICY",
            path,
            `core \`${id}\` never appears in a policy or selection`,
          ),
        );
      }
    });
  }
}

/** Unknown or misplaced ids across every runtime document of a resolve input. */
export function diagnoseRuntimeDocuments(
  input: ResolveInput,
): readonly Diagnostic[] {
  const diags: Diagnostic[] = [];
  const index = indexCatalog(input.catalog);
  checkIds([...policySources(input), ...selectionSources(input)], index, diags);
  input.distribution.capabilityIds.forEach((id, i) => {
    if (!index.has(id)) {
      pushDiagnostic(
        diags,
        diagnostic(
          "UNKNOWN_CAPABILITY",
          `distribution.capabilityIds[${i}]`,
          `\`${id}\` is distributed but not in the catalog`,
        ),
      );
    }
  });
  const knownModules = new Set(
    input.catalog.capabilities.flatMap((d) => d.moduleIds),
  );
  input.distribution.moduleIds.forEach((id, i) => {
    if (!knownModules.has(id)) {
      pushDiagnostic(
        diags,
        diagnostic(
          "UNKNOWN_MODULE",
          `distribution.moduleIds[${i}]`,
          `\`${id}\` is distributed but no capability owns it`,
        ),
      );
    }
  });
  if (input.installation !== null) {
    const slots = new Set(
      input.catalog.capabilities.flatMap((d) =>
        d.alternatives.map((a) => a.slot),
      ),
    );
    for (const slot of Object.keys(
      input.installation.chosenAlternatives,
    ).sort()) {
      if (!slots.has(slot)) {
        pushDiagnostic(
          diags,
          diagnostic(
            "UNKNOWN_SLOT",
            `installation.chosenAlternatives.${slot}`,
            `no capability declares slot \`${slot}\``,
          ),
        );
      }
    }
  }
  return diags;
}
