import { name } from "@gdp-ts/core";
import type { Organization } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { organizationId } from "../lib/ids.js";
import { writeIssuerAdmittedOrganization } from "../services/org-issuer-approval.js";
import {
  organizationIssuerAdmission,
  organizationIssuerUpdateAdmission,
} from "./organization-issuer-admission.js";

const issuer = "https://idp.example";
it.each([
  { approvals: [] },
  { approvals: [issuer] },
  { approvals: [`org:other|${issuer}`] },
  { approvals: ["org:approved|https://other.example"] },
])(
  "refuses issuer admission without the exact operator pair %j",
  ({ approvals }) => {
    const { ctx } = createControlPlane({
      config: { organizationIssuerAllowlist: approvals },
    });
    name(
      organizationId("org:approved"),
      { ssoIssuer: issuer },
      (org, claim) => {
        expect(
          organizationIssuerAdmission(ctx.config, org, claim),
        ).toMatchObject({ ok: false });
      },
    );
  },
);

it("carries real approval into the exact persisted organization row", async () => {
  const { ctx } = createControlPlane({
    config: { organizationIssuerAllowlist: [`org:approved|${issuer}/`] },
  });
  const row: Organization = {
    id: "org:approved",
    slug: "approved",
    displayName: "Approved",
    state: "active",
    createdBy: "prn_owner",
    createdAt: ctx.clock(),
    updatedAt: ctx.clock(),
    ssoIssuer: issuer,
  };
  await name(organizationId(row.id), row, async (org, configuration) => {
    const verdict = organizationIssuerAdmission(ctx.config, org, configuration);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error(verdict.message);
    await writeIssuerAdmittedOrganization(
      ctx,
      org,
      configuration,
      verdict.proof,
    );
  });
  expect(await ctx.stores.organizations.get(row.id)).toMatchObject({
    ssoIssuer: issuer,
  });
});

it("requires approval for every issuer but permits removal of legacy claims", () => {
  const { ctx } = createControlPlane({
    config: { organizationIssuerAllowlist: [`org:approved|${issuer}`] },
  });
  name(
    organizationId("org:approved"),
    { ssoIssuer: issuer, samlIssuer: "https://other.example" },
    {},
    (org, both, cleared) => {
      expect(organizationIssuerAdmission(ctx.config, org, both)).toMatchObject({
        ok: false,
      });
      expect(
        organizationIssuerAdmission(ctx.config, org, cleared),
      ).toMatchObject({ ok: true });
    },
  );
});

it("admits unrelated edits and removals while refusing changed issuers", () => {
  const { ctx } = createControlPlane({
    config: {
      organizationIssuerAllowlist: [`org:approved|${issuer}`],
    },
  });
  const previous = {
    ssoIssuer: issuer,
    samlIssuer: "https://unapproved.example",
  };
  name(
    organizationId("org:approved"),
    { ...previous, displayName: "Renamed" },
    {},
    (org, renamed) => {
      expect(
        organizationIssuerUpdateAdmission(ctx.config, org, previous, renamed),
      ).toMatchObject({ ok: true });
    },
  );
  name(
    organizationId("org:approved"),
    { ssoIssuer: issuer },
    {},
    (org, cleared) => {
      expect(
        organizationIssuerUpdateAdmission(ctx.config, org, previous, cleared),
      ).toMatchObject({ ok: true });
    },
  );
  name(
    organizationId("org:approved"),
    { ...previous, ssoIssuer: "https://changed.example" },
    {},
    (org, changed) => {
      expect(
        organizationIssuerUpdateAdmission(ctx.config, org, previous, changed),
      ).toMatchObject({ ok: false });
    },
  );
  name(
    organizationId("org:approved"),
    { ssoIssuer: issuer, samlIssuer: "https://added.example" },
    {},
    (org, added) => {
      expect(
        organizationIssuerUpdateAdmission(ctx.config, org, previous, added),
      ).toMatchObject({ ok: false });
    },
  );
});
