import { expect, it } from "vitest";
import { nativeApiVerificationRequest } from "./native-api-auth.js";
import { projectTinybirdDataSources } from "./native-api-catalog-resources.js";
import {
  invokeNativeApiResource,
  nativeApiResourceActions,
} from "./native-api-resources.js";
import { nativeApiFingerprint, nativeApiTarget } from "./native-api-target.js";
import { nativeAnswers } from "./native-api.test-support.js";

it("advertises a real data-source read rather than the access check", () => {
  expect(nativeApiResourceActions("tinybird", "api-key")).toEqual([
    { id: "provider.datasources.read", label: "List data sources" },
  ]);
  expect(nativeApiResourceActions("tinybird", "oauth")).toEqual([]);
});
it.each(["api.tinybird.co", "api.us-east.tinybird.co"])(
  "binds verification and public configuration to the exact %s workspace region",
  (host) => {
    const target = nativeApiTarget("tinybird", { api_host: host });
    const request = nativeApiVerificationRequest(target, {
      api_key: "owned-key",
    });
    expect(request.url.href).toBe(`https://${host}/v0/datasources?attrs=name`);
    expect(request.method).toBe("GET");
    expect(new Headers(request.headers).get("authorization")).toBe(
      "Bearer owned-key",
    );
    expect(target.parameters).toEqual({ api_host: host });
    expect(target.classification).toEqual({
      publicParameters: ["api_host"],
      privateCredentials: ["api_key"],
    });
  },
);
it("defaults only to EU and gives distinct target fingerprints to EU, US and the old fixed-EU contract", async () => {
  const eu = nativeApiTarget("tinybird", {});
  const us = nativeApiTarget("tinybird", {
    api_host: "api.us-east.tinybird.co",
  });
  expect(eu.parameters).toEqual({ api_host: "api.tinybird.co" });
  if (!eu.profile.verify) throw new Error("Missing Tinybird verification");
  const old = {
    ...eu,
    parameters: {},
    classification: { publicParameters: [], privateCredentials: ["api_key"] },
    profile: {
      ...eu.profile,
      templateParams: [],
      verify: {
        ...eu.profile.verify,
        url: "https://api.tinybird.co/v0/sql?q=SELECT+1",
        requiredFields: [],
      },
    },
  };
  const fingerprints = await Promise.all(
    [eu, us, old].map(nativeApiFingerprint),
  );
  expect(new Set(fingerprints).size).toBe(3);
});
it.each([
  "https://api.tinybird.co",
  "api.tinybird.co.evil.example",
  "api.tinybird.co/path",
  "api.eu-west-2.aws.tinybird.co",
  "api.tinybird.co\r\nX: y",
])("refuses noncompiled workspace host %j", (api_host) =>
  expect(() => nativeApiTarget("tinybird", { api_host })).toThrow(),
);
it("projects only names, dropping schema, authentication headers, URLs and private statistics", () => {
  expect(
    projectTinybirdDataSources({
      datasources: [
        {
          name: "events",
          id: "private-id",
          headers: { authorization: "private-token" },
          columns: [{ name: "private-column" }],
          statistics: { rows: 123 },
          url: "https://untrusted.example",
        },
      ],
    }),
  ).toEqual({
    label: "Showing 1 of 1 returned data sources",
    items: [{ id: "events", label: "events" }],
  });
  expect(projectTinybirdDataSources({ datasources: [] })).toEqual({
    label: "Showing 0 of 0 returned data sources",
    items: [],
  });
});
it("validates every returned source before projecting the first twenty without inventing pagination", () => {
  const rows = Array.from({ length: 37 }, (_, i) => ({ name: `source_${i}` }));
  expect(projectTinybirdDataSources({ datasources: rows })).toEqual({
    label: "Showing 20 of 37 returned data sources",
    items: rows.slice(0, 20).map(({ name }) => ({ id: name, label: name })),
  });
  expect(() =>
    projectTinybirdDataSources({
      datasources: [...rows, { name: "bad\nname" }],
    }),
  ).toThrow();
  expect(() =>
    projectTinybirdDataSources({ datasources: [...rows, rows[0]] }),
  ).toThrow();
});
it.each([
  {},
  null,
  { datasources: null },
  { data: [] },
  { datasources: [{}] },
  { datasources: [{ name: 1 }] },
  { datasources: [{ name: "" }] },
  { datasources: [{ name: "x".repeat(257) }] },
  { datasources: [], error: "denied" },
  { datasources: [], errors: [] },
])("refuses malformed, error or secret-only resource envelopes %#", (body) =>
  expect(() => projectTinybirdDataSources(body)).toThrow(),
);
it("rejects caller-selected region, SQL, URL, pagination and credential overrides before dispatch", async () => {
  const { transport, fetch } = nativeAnswers();
  for (const field of ["api_host", "url", "q", "page", "api_key", "attrs"])
    await expect(
      invokeNativeApiResource(
        "tinybird",
        "not-saved",
        "provider.datasources.read",
        { [field]: "override" },
        transport,
      ),
    ).rejects.toThrow(/does not accept/);
  expect(fetch).not.toHaveBeenCalled();
});
