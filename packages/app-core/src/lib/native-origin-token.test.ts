import { afterEach, describe, expect, it } from "vitest";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";
import { mintNativeOriginInstallationToken } from "./native-origin-token.js";
import {
  ORIGIN_TEST_INSTALLATION,
  originFixture,
} from "./native-origin.test-support.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup() {
  const fixture = await originFixture();
  closes.push(fixture.close);
  const saved = await fixture.driver.configure(fixture.input);
  const record = requireNativeOAuthRecord(saved.connectionId);
  return { fixture, saved, record };
}
describe("Origin installation token attenuation", () => {
  it("sends optional repository IDs without inventing scopes", async () => {
    const { fixture, saved, record } = await setup();
    const grant = await mintNativeOriginInstallationToken({
      connectionId: saved.connectionId,
      configuration: record.configuration,
      installationId: ORIGIN_TEST_INSTALLATION,
      scopes: [],
      repositoryIds: ["repo_synthetic"],
      owner: fixture.owner,
    });
    expect(JSON.parse(fixture.state.calls[0]?.body ?? "{}")).toEqual({
      repositoryIds: ["repo_synthetic"],
    });
    expect(grant.scopes).toEqual([]);
    expect(grant.targetId).toBe(ORIGIN_TEST_INSTALLATION);
  });
  it("refuses duplicate or more than 50 repository IDs before a request", async () => {
    const { fixture, saved, record } = await setup();
    for (const repositoryIds of [
      ["repo_same", "repo_same"],
      Array.from({ length: 51 }, (_, index) => `repo_${index}`),
    ])
      await expect(
        mintNativeOriginInstallationToken({
          connectionId: saved.connectionId,
          configuration: record.configuration,
          installationId: ORIGIN_TEST_INSTALLATION,
          scopes: [],
          repositoryIds,
          owner: fixture.owner,
        }),
      ).rejects.toThrow();
    expect(fixture.state.calls).toEqual([]);
  });
  it("refuses an installation token that outlives its app JWT", async () => {
    const { fixture, saved, record } = await setup();
    fixture.state.tokenLifetime = 900_000;
    await expect(
      mintNativeOriginInstallationToken({
        connectionId: saved.connectionId,
        configuration: record.configuration,
        installationId: ORIGIN_TEST_INSTALLATION,
        scopes: [],
        owner: fixture.owner,
      }),
    ).rejects.toMatchObject({ code: "provider" });
  });
});
