export type RecipeResource = {
  kind: "local_application" | "prefs" | "claim_mapping" | "item_type";
  logicalId: string;
  body: Record<string, unknown>;
};

export type RecipeManifest = {
  schema: "opensesame.recipe.v1";
  name: string;
  resources: RecipeResource[];
  requiredInputs: readonly string[];
  omissions: readonly string[];
};

const STRIP = new Set([
  "clientSecret",
  "privateKey",
  "refreshToken",
  "accessToken",
  "recoveryCodes",
  "ownerPrincipalId",
  "grantId",
  "sessionId",
  "note",
  "notes",
  "comment",
  "comments",
]);

function isAuthorityKey(key: string): boolean {
  return (
    STRIP.has(key) ||
    key.toLowerCase().includes("secret") ||
    key.toLowerCase().includes("password")
  );
}

function containsAuthority(body: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(body)) {
    if (isAuthorityKey(key)) return true;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if (containsAuthority(value as Record<string, unknown>)) return true;
    }
  }
  return false;
}

function allowlisted(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (isAuthorityKey(key)) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      next[key] = allowlisted(value as Record<string, unknown>);
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Rebuild from allowlisted semantics. Comments never enter the recipe. */
export function exportRecipe(input: {
  name: string;
  resources: RecipeResource[];
  requiredInputs?: readonly string[];
}): RecipeManifest {
  return {
    schema: "opensesame.recipe.v1",
    name: input.name,
    resources: input.resources.map((resource) => ({
      kind: resource.kind,
      logicalId: resource.logicalId,
      body: allowlisted(resource.body),
    })),
    requiredInputs: input.requiredInputs ?? ["organization"],
    omissions: [
      "Live credentials, grants, sessions, and owner assignments are omitted.",
    ],
  };
}

export function previewRecipe(manifest: RecipeManifest): {
  resources: number;
  omissions: readonly string[];
  requiredInputs: readonly string[];
} {
  return {
    resources: manifest.resources.length,
    omissions: manifest.omissions,
    requiredInputs: manifest.requiredInputs,
  };
}

export function importRecipe(
  manifest: RecipeManifest,
  bindings: Record<string, string>,
): { ok: true; bound: RecipeManifest } | { ok: false; message: string } {
  if (manifest.schema !== "opensesame.recipe.v1") {
    return { ok: false, message: "Unsupported recipe schema." };
  }
  for (const required of manifest.requiredInputs) {
    if (!bindings[required]) {
      return { ok: false, message: `Missing binding for ${required}.` };
    }
  }
  for (const resource of manifest.resources) {
    if (containsAuthority(resource.body)) {
      return { ok: false, message: "Recipe contains authority material." };
    }
  }
  return { ok: true, bound: manifest };
}

export type RecipeApplyPort = {
  applyLocalApplication: (input: {
    logicalId: string;
    organizationId: string;
    redirectUris: string[];
    scopes: string[];
  }) => Promise<void>;
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Apply a bound recipe through owning adapters. Repeat apply is idempotent. */
export async function applyBoundRecipe(
  bound: RecipeManifest,
  bindings: Record<string, string>,
  port: RecipeApplyPort,
): Promise<{ ok: true; applied: string[] } | { ok: false; message: string }> {
  const organizationId = bindings.organization;
  if (!organizationId) {
    return { ok: false, message: "Missing binding for organization." };
  }
  const applied: string[] = [];
  for (const resource of bound.resources) {
    if (resource.kind !== "local_application") continue;
    const redirectUris = stringList(resource.body.redirectUris);
    const scopes = stringList(resource.body.scopes);
    if (redirectUris.length === 0 || scopes.length === 0) {
      return {
        ok: false,
        message: `Recipe resource ${resource.logicalId} is missing redirectUris or scopes.`,
      };
    }
    await port.applyLocalApplication({
      logicalId: resource.logicalId,
      organizationId,
      redirectUris,
      scopes,
    });
    applied.push(resource.logicalId);
  }
  return { ok: true, applied };
}
