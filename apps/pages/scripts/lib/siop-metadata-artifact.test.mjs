import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializePagesSiopMetadata } from "@opensesame/siop-v2";
import { afterEach, expect, it } from "vitest";
import { checkPublishedMetadata } from "./siop-spa-journey.mjs";

const origin = "https://pages.example.test";
const basePath = "/OpenSesame/";
const expected = serializePagesSiopMetadata({ origin, basePath });
const directories = [];
function artifact(document = expected) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "siop-metadata-"));
  directories.push(dist);
  fs.writeFileSync(path.join(dist, "siop-metadata.json"), document);
  return { dist, verifier: { expectedMetadataText: () => document } };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it("accepts self-issued metadata beside the isolated web app manifest", () => {
  const { dist, verifier } = artifact();
  fs.mkdirSync(path.join(dist, ".well-known"));
  fs.writeFileSync(path.join(dist, ".well-known/manifest.webmanifest"), "{}");
  expect(() =>
    checkPublishedMetadata(dist, verifier, origin, basePath),
  ).not.toThrow();
});

it.each([
  "openid-configuration",
  "oauth-authorization-server",
  "jwks.json",
  "unreviewed.json",
])(
  "refuses discovery or an unreviewed artifact at .well-known/%s",
  (document) => {
    const { dist, verifier } = artifact();
    fs.mkdirSync(path.join(dist, ".well-known"));
    fs.writeFileSync(path.join(dist, ".well-known", document), "{}");
    expect(() =>
      checkPublishedMetadata(dist, verifier, origin, basePath),
    ).toThrow();
  },
);

it.each(["token_endpoint", "jwks_uri"])("refuses an advertised %s", (claim) => {
  const document = JSON.stringify({
    ...JSON.parse(expected),
    [claim]: `${origin}/private`,
  });
  const { dist, verifier } = artifact(document);
  expect(() =>
    checkPublishedMetadata(dist, verifier, origin, basePath),
  ).toThrow();
});

it("refuses conventional_oidc even when artifact bytes match the expected document", () => {
  const parsed = JSON.parse(expected);
  parsed.opensesame.conventional_oidc = true;
  const { dist, verifier } = artifact(JSON.stringify(parsed));
  expect(() =>
    checkPublishedMetadata(dist, verifier, origin, basePath),
  ).toThrow();
});
