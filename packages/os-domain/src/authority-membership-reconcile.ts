/**
 * GA-I-02 — reconcile ADR 0038 project memberships into authority membership
 * edges (pure plan; Identity live apply is
 * `AuthorityMembershipEdgeStore.applyPlan` in `@opensesame/database`).
 *
 * Personal projects refuse membership entirely (ADR 0038). A removed member's
 * edge is invalidated with a reason — never deleted silently so re-add cannot
 * inherit the prior eligibility window.
 */

import type { ProjectKind, ProjectMembership, ProjectRole } from "./types.js";

export type MembershipEdgeRelation = "member" | "nested_cohort" | "observer";

export type AuthorityMembershipEdgeSnapshot = {
  readonly id: string;
  readonly organizationId: string;
  readonly cohortId: string;
  readonly subjectPrincipalId: string;
  readonly relation: MembershipEdgeRelation;
  readonly subjectKind: "person";
  readonly source: string;
  readonly issuingAuthority: string;
  readonly role: ProjectRole;
  readonly invalidatedAt: Date | null;
};

export type MembershipEdgeUpsert = {
  readonly op: "upsert";
  readonly organizationId: string;
  readonly cohortId: string;
  readonly subjectPrincipalId: string;
  readonly relation: "member";
  readonly subjectKind: "person";
  readonly source: "project_membership_reconcile";
  readonly issuingAuthority: "identity.project_memberships";
  readonly role: ProjectRole;
};

export type MembershipEdgeInvalidate = {
  readonly op: "invalidate";
  readonly edgeId: string;
  readonly reason: "project_membership_removed" | "personal_project_refused";
};

export type MembershipReconcilePlan = {
  readonly upserts: readonly MembershipEdgeUpsert[];
  readonly invalidations: readonly MembershipEdgeInvalidate[];
};

export type MembershipReconcileError = {
  readonly code: "personal_project";
  readonly message: string;
};

export type MembershipReconcileResult =
  | { readonly ok: true; readonly plan: MembershipReconcilePlan }
  | { readonly ok: false; readonly error: MembershipReconcileError };

const SOURCE = "project_membership_reconcile" as const;
const ISSUER = "identity.project_memberships" as const;

export function cohortIdForProject(projectId: string): string {
  return `project:${projectId}`;
}

function edgeKey(subjectPrincipalId: string, relation: string): string {
  return `${subjectPrincipalId}#${relation}`;
}

function personalProjectPlan(input: {
  readonly projectId: string;
  readonly memberships: readonly ProjectMembership[];
  readonly existingEdges: readonly AuthorityMembershipEdgeSnapshot[];
}): MembershipReconcileResult {
  const cohortId = cohortIdForProject(input.projectId);
  if (input.memberships.length > 0) {
    return {
      ok: false,
      error: {
        code: "personal_project",
        message:
          "personal projects refuse membership; clear edges instead of reconciling",
      },
    };
  }
  const invalidations: MembershipEdgeInvalidate[] = [];
  for (const edge of input.existingEdges) {
    if (edge.cohortId !== cohortId) continue;
    if (edge.invalidatedAt !== null) continue;
    invalidations.push({
      op: "invalidate",
      edgeId: edge.id,
      reason: "personal_project_refused",
    });
  }
  return { ok: true, plan: { upserts: [], invalidations } };
}

function desiredByPrincipal(
  projectId: string,
  memberships: readonly ProjectMembership[],
): Map<string, ProjectMembership> {
  const desired = new Map<string, ProjectMembership>();
  for (const membership of memberships) {
    if (membership.projectId !== projectId) continue;
    desired.set(membership.principalId, membership);
  }
  return desired;
}

function upsertFor(
  organizationId: string,
  cohortId: string,
  membership: ProjectMembership,
): MembershipEdgeUpsert {
  return {
    op: "upsert",
    organizationId,
    cohortId,
    subjectPrincipalId: membership.principalId,
    relation: "member",
    subjectKind: "person",
    source: SOURCE,
    issuingAuthority: ISSUER,
    role: membership.role,
  };
}

type ActiveEdgeReconcile = {
  readonly upserts: MembershipEdgeUpsert[];
  readonly invalidations: MembershipEdgeInvalidate[];
  readonly seenActive: Set<string>;
};

type ActiveEdgeReconcileInput = {
  readonly organizationId: string;
  readonly cohortId: string;
  readonly desired: Map<string, ProjectMembership>;
  readonly existingEdges: readonly AuthorityMembershipEdgeSnapshot[];
};

function reconcileActiveEdges(input: ActiveEdgeReconcileInput): ActiveEdgeReconcile {
  const upserts: MembershipEdgeUpsert[] = [];
  const invalidations: MembershipEdgeInvalidate[] = [];
  const seenActive = new Set<string>();

  for (const edge of input.existingEdges) {
    if (edge.cohortId !== input.cohortId) continue;
    if (edge.organizationId !== input.organizationId) continue;
    if (edge.invalidatedAt !== null) continue;
    if (edge.relation !== "member" || edge.subjectKind !== "person") continue;

    const key = edgeKey(edge.subjectPrincipalId, edge.relation);
    seenActive.add(key);
    const membership = input.desired.get(edge.subjectPrincipalId);
    if (membership === undefined) {
      invalidations.push({
        op: "invalidate",
        edgeId: edge.id,
        reason: "project_membership_removed",
      });
      continue;
    }
    if (membership.role !== edge.role) {
      upserts.push(upsertFor(input.organizationId, input.cohortId, membership));
    }
  }

  return { upserts, invalidations, seenActive };
}

/**
 * Diff project memberships against existing authority edges for that project
 * cohort. Does not touch the database.
 */
export function planProjectMembershipReconcile(input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly projectKind: ProjectKind;
  readonly memberships: readonly ProjectMembership[];
  readonly existingEdges: readonly AuthorityMembershipEdgeSnapshot[];
}): MembershipReconcileResult {
  if (input.projectKind === "personal") {
    return personalProjectPlan(input);
  }

  const cohortId = cohortIdForProject(input.projectId);
  const desired = desiredByPrincipal(input.projectId, input.memberships);
  const active = reconcileActiveEdges({
    organizationId: input.organizationId,
    cohortId,
    desired,
    existingEdges: input.existingEdges,
  });

  const upserts = [...active.upserts];
  for (const membership of desired.values()) {
    const key = edgeKey(membership.principalId, "member");
    if (active.seenActive.has(key)) continue;
    upserts.push(upsertFor(input.organizationId, cohortId, membership));
  }

  return {
    ok: true,
    plan: { upserts, invalidations: active.invalidations },
  };
}
