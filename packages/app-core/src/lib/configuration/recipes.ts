import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export type RecipeResource = {
  kind: "local_application" | "prefs" | "claim_mapping" | "item_type";
  logicalId: string;
  body: JsonObject;
};

export type RecipeManifest = {
  schema: "opensesame.recipe.v1";
  name: string;
  resources: RecipeResource[];
  requiredInputs: readonly string[];
  omissions: readonly string[];
};

export type RecipePreview = {
  resources: number;
  omissions: readonly string[];
  requiredInputs: readonly string[];
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
  const lower = key.toLowerCase();
  return (
    STRIP.has(key) ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("token") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("privatekey") ||
    lower.includes("private_key") ||
    lower.includes("credential")
  );
}

function containsAuthority(body: JsonObject): boolean {
  for (const [key, value] of Object.entries(body)) {
    if (isAuthorityKey(key)) return true;
    if (isJsonObject(value)) {
      if (containsAuthority(value)) return true;
    } else if (Array.isArray(value) && arrayContainsAuthority(value)) {
      return true;
    }
  }
  return false;
}

function arrayContainsAuthority(values: readonly JsonValue[]): boolean {
  for (const item of values) {
    if (isJsonObject(item)) {
      if (containsAuthority(item)) return true;
    } else if (Array.isArray(item) && arrayContainsAuthority(item)) {
      return true;
    }
  }
  return false;
}

function allowlistedValue(value: JsonValue): JsonValue {
  if (isJsonObject(value)) return allowlisted(value);
  if (Array.isArray(value)) return value.map(allowlistedValue);
  return value;
}

function allowlisted(body: JsonObject): JsonObject {
  const next: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (isAuthorityKey(key)) continue;
    next[key] = value === undefined ? value : allowlistedValue(value);
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

export function previewRecipe(manifest: RecipeManifest): RecipePreview {
  return {
    resources: manifest.resources.length,
    omissions: manifest.omissions,
    requiredInputs: manifest.requiredInputs,
  };
}

function isRecipeManifestShape(manifest: RecipeManifest): boolean {
  return (
    Array.isArray(manifest.requiredInputs) &&
    manifest.requiredInputs.every(isString) &&
    Array.isArray(manifest.resources) &&
    manifest.resources.every(
      (resource) =>
        isJsonObject(resource) &&
        isString(resource.kind) &&
        isString(resource.logicalId) &&
        isJsonObject(resource.body),
    )
  );
}

export function importRecipe(
  manifest: RecipeManifest,
  bindings: Record<string, string>,
): { ok: true; bound: RecipeManifest } | { ok: false; message: string } {
  if (manifest.schema !== "opensesame.recipe.v1") {
    return { ok: false, message: "Unsupported recipe schema." };
  }
  if (!isRecipeManifestShape(manifest)) {
    return { ok: false, message: "Malformed recipe manifest." };
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

function stringList(value: BoundaryValue): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (isString(item)) out.push(item);
  }
  return out;
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
    try {
      await port.applyLocalApplication({
        logicalId: resource.logicalId,
        organizationId,
        redirectUris,
        scopes,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "LocalDirectoryError") {
        throw error;
      }
      const detail = error instanceof Error ? `: ${error.message}` : "";
      const partial =
        applied.length > 0
          ? ` Partial application: ${applied.join(", ")} already applied.`
          : "";
      return {
        ok: false,
        message: `Recipe resource ${resource.logicalId} failed to apply${detail}.${partial}`,
      };
    }
    applied.push(resource.logicalId);
  }
  return { ok: true, applied };
}
