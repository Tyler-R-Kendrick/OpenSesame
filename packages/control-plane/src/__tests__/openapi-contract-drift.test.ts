import * as contracts from "@opensesame/contracts";
import {
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { buildOpenApiDocument } from "../openapi.js";

/**
 * The published OpenAPI schemas and the Zod contracts the routes really parse
 * and answer with must describe the same shapes.
 *
 * `openapi.json` is hand-written and the routes are held to Zod, so nothing
 * but this test notices the two parting ways. It did, once: the Zod
 * `AuthorizationRequestResponseSchema` answered `requesterRef` and `approval`
 * while the published schema was `additionalProperties: false` and named
 * neither — a generated client would have rejected a correct response. The
 * class is "a key on one side and not the other", so that is what is compared,
 * recursively, for every pair below: the set of property names, which of them
 * are required, closedness (`strict` / `passthrough` against
 * `additionalProperties`), and the members of every enum.
 *
 * Only shapes are compared. Bounds (`minLength`) and descriptions are prose a
 * reviewer reads; a missing key is a defect a client trips over.
 */

const document = buildOpenApiDocument(
  loadConfig({ OPENSESAME_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" }),
);
const components: JsonObject = overlapCast(document.components.schemas);

function resolve(schema: JsonObject): JsonObject {
  const ref = schema.$ref;
  if (!isString(ref)) return schema;
  const name = ref.replace("#/components/schemas/", "");
  const target = components[name];
  if (!isJsonObject(target)) throw new Error(`unresolved $ref ${ref}`);
  return resolve(target);
}

function unwrap(type: z.ZodTypeAny) {
  let inner = type;
  let optional = false;
  for (;;) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
      optional = true;
      inner = inner._def.innerType;
    } else if (inner instanceof z.ZodNullable) {
      inner = inner._def.innerType;
    } else {
      return { inner, optional };
    }
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** The key under which Zod keeps an object's member schemas. */
const MEMBER_MAP_KEY = "shape";

/** The member schemas of a Zod object, by key. */
function membersOf(type: z.AnyZodObject): Record<string, z.ZodTypeAny> {
  return type[MEMBER_MAP_KEY];
}

function compareObject(
  type: z.AnyZodObject,
  schema: JsonObject,
  path: string,
  problems: string[],
): void {
  const members = membersOf(type);
  const documented = isJsonObject(schema.properties) ? schema.properties : {};
  const zodKeys = sorted(Object.keys(members));
  const docKeys = sorted(Object.keys(documented));
  const missing = zodKeys.filter((key) => !docKeys.includes(key));
  const extra = docKeys.filter((key) => !zodKeys.includes(key));
  if (missing.length > 0) {
    problems.push(
      `${path}: contract has ${missing.join(", ")}, OpenAPI does not`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `${path}: OpenAPI has ${extra.join(", ")}, contract does not`,
    );
  }
  const zodRequired = zodKeys.filter((key) => {
    const member = members[key];
    return member !== undefined && !unwrap(member).optional;
  });
  const docRequired = Array.isArray(schema.required)
    ? sorted(schema.required.map(String))
    : [];
  if (zodRequired.join() !== docRequired.join()) {
    problems.push(
      `${path}: required differs (contract [${zodRequired}], OpenAPI [${docRequired}])`,
    );
  }
  const unknownKeys: string = type._def.unknownKeys;
  if (unknownKeys === "strict" && schema.additionalProperties !== false) {
    problems.push(`${path}: contract is strict, OpenAPI is not closed`);
  }
  if (unknownKeys === "passthrough" && schema.additionalProperties === false) {
    problems.push(`${path}: contract passes extra keys, OpenAPI is closed`);
  }
  for (const key of zodKeys) {
    const member = members[key];
    const doc = documented[key];
    if (member && isJsonObject(doc)) {
      compare(member, doc, `${path}.${key}`, problems);
    }
  }
}

function compare(
  type: z.ZodTypeAny,
  schemaOrRef: JsonObject,
  path: string,
  problems: string[],
): void {
  const { inner } = unwrap(type);
  const schema = resolve(schemaOrRef);
  if (inner instanceof z.ZodObject) {
    compareObject(inner, schema, path, problems);
  } else if (inner instanceof z.ZodArray) {
    if (isJsonObject(schema.items)) {
      compare(inner.element, schema.items, `${path}[]`, problems);
    }
  } else if (inner instanceof z.ZodEnum) {
    const zodValues = sorted(inner.options);
    const docValues = Array.isArray(schema.enum)
      ? sorted(schema.enum.map(String))
      : [];
    if (zodValues.join() !== docValues.join()) {
      problems.push(
        `${path}: enum differs (contract [${zodValues}], OpenAPI [${docValues}])`,
      );
    }
  }
}

/** [OpenAPI component, contract]. Every pair here is held to the comparison. */
const PAIRS: ReadonlyArray<readonly [string, z.ZodTypeAny]> = [
  ["AuthorizationRequestStatus", contracts.AuthorizationRequestStatusSchema],
  ["ApprovalDecidedByKind", contracts.ApprovalDecidedByKindSchema],
  ["AuthorizationDetail", contracts.AuthorizationDetailSchema],
  ["CreateAuthorizationRequest", contracts.CreateAuthorizationRequestSchema],
  ["AuthorizationRequest", contracts.AuthorizationRequestResponseSchema],
  ["InteractionKind", contracts.InteractionKindSchema],
  ["InteractionStatus", contracts.InteractionStatusSchema],
  ["ApprovalMechanism", contracts.ApprovalMechanismSchema],
  ["InteractionErrorCode", contracts.InteractionErrorCodeSchema],
  ["InteractionSubject", contracts.InteractionSubjectSchema],
  ["CreateInteraction", contracts.CreateInteractionSchema],
  ["InteractionCreated", contracts.InteractionCreatedResponseSchema],
  ["InteractionSummary", contracts.InteractionSummaryResponseSchema],
  ["InteractionDetail", contracts.InteractionDetailResponseSchema],
  ["ApprovalProof", contracts.ApprovalProofSchema],
  ["AssuranceLevel", contracts.AssuranceLevelSchema],
  ["ApproveInteraction", contracts.ApproveInteractionSchema],
  ["DenyInteraction", contracts.DenyInteractionSchema],
  ["OrganizationState", contracts.OrganizationStateSchema],
  ["OrganizationRole", contracts.OrganizationRoleSchema],
  ["ProjectState", contracts.ProjectStateSchema],
  ["ProjectKind", contracts.ProjectKindSchema],
  ["ProjectRole", contracts.ProjectRoleSchema],
  ["CreateOrganization", contracts.CreateOrganizationRequestSchema],
  ["Organization", contracts.OrganizationResponseSchema],
  ["OrganizationMembership", contracts.OrganizationMembershipResponseSchema],
  ["AddOrganizationMember", contracts.AddOrganizationMemberRequestSchema],
  [
    "ChangeOrganizationMemberRole",
    contracts.ChangeOrganizationMemberRoleRequestSchema,
  ],
  ["JoinOrganizationTenant", contracts.JoinOrganizationTenantRequestSchema],
  ["OrganizationTenant", contracts.OrganizationTenantResponseSchema],
  ["OrganizationAuthMethod", contracts.OrganizationAuthMethodSchema],
  ["CreateProject", contracts.CreateProjectRequestSchema],
  ["Project", contracts.ProjectResponseSchema],
  ["ProjectMembership", contracts.ProjectMembershipResponseSchema],
  ["AddProjectMember", contracts.AddProjectMemberRequestSchema],
  ["ChangeProjectMemberRole", contracts.ChangeProjectMemberRoleRequestSchema],
  ["ActiveProject", contracts.ActiveProjectResponseSchema],
  ["SetActiveProject", contracts.SetActiveProjectRequestSchema],
];

describe("OpenAPI and the Zod contracts describe the same shapes", () => {
  for (const [name, type] of PAIRS) {
    it(`${name} matches its contract`, () => {
      const published = components[name];
      expect(published, `${name} is published`).toBeDefined();
      const problems: string[] = [];
      compare(type, overlapCast(published), name, problems);
      expect(problems).toEqual([]);
    });
  }

  it("catches the class: a response key the schema does not name", () => {
    // The regression this test exists for, reproduced in miniature: a
    // closed schema that omits a key its contract answers.
    const contract = z.object({
      id: z.string(),
      requesterRef: z.string().optional(),
    });
    const closed: JsonObject = {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    };
    const problems: string[] = [];
    compare(contract, closed, "Mini", problems);
    expect(problems).toEqual([
      "Mini: contract has requesterRef, OpenAPI does not",
    ]);
  });

  it("catches the class: an enum member the contract does not have", () => {
    const problems: string[] = [];
    compare(
      z.enum(["a", "b"]),
      { type: "string", enum: ["a"] },
      "Mini",
      problems,
    );
    expect(problems).toEqual([
      "Mini: enum differs (contract [a,b], OpenAPI [a])",
    ]);
  });
});
