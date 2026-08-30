import { describe, expect, it } from "vitest";
import { buildHealthReport } from "./health.js";
import { SAMPLE_FOLDER_NAME, buildSample, sampleFolder } from "./sample.js";

describe("buildSample", () => {
  it("builds one of each demonstrative shape, all flagged as samples", () => {
    const items = buildSample("folder-1");
    expect(items).toHaveLength(7);
    expect(new Set(items.map((item) => item.kind))).toEqual(
      new Set(["login", "passkey", "card", "secret", "note"]),
    );
    for (const item of items) {
      expect(item.sample).toBe(true);
      expect(item.folderId).toBe("folder-1");
    }
  });

  it("keeps secrets on a leash: ceiling grants, never the value in notes", () => {
    const secret = buildSample("f").find((item) => item.kind === "secret");
    if (secret?.kind !== "secret") throw new Error("expected a secret sample");
    expect(secret.connectionRef).toBe("conn_deploy_webhook");
    expect(secret.grantees).toEqual(["agt_release_bot"]);
    expect(secret.ceiling.map((grant) => grant.action)).toEqual([
      "http.post",
      "http.get",
    ]);
    expect(secret.notes).not.toContain(secret.value);
  });

  it("deliberately trips the health report so the demo has something to show", () => {
    const items = buildSample("f");
    const report = buildHealthReport(items);
    // The forum and supplier logins share a password on purpose.
    expect(report.counts.reused).toBe(2);
    // "summer2019" is weak, and the forum login is years old with no 2FA.
    expect(report.counts.weak).toBeGreaterThanOrEqual(2);
    expect(report.counts.old).toBeGreaterThanOrEqual(1);
    const forum = report.findings.find(
      (finding) => finding.item.name === "Old forum account",
    );
    expect(forum?.issues).toEqual(
      expect.arrayContaining(["weak", "reused", "old", "no-2fa"]),
    );
    expect(forum?.sharedWith).toEqual(["Parts supplier"]);
  });

  it("marks the bank login as a favorite with 2FA enrolled", () => {
    const bank = buildSample("f").find(
      (item) => item.kind === "login" && item.favorite,
    );
    if (bank?.kind !== "login") throw new Error("expected a favorite login");
    expect(bank.totp).toBeTruthy();
    expect(bank.uris[0]?.uri).toBe("https://northwind.example.com");
  });
});

describe("sampleFolder", () => {
  it("mints a fresh folder with the well-known name each time", () => {
    const a = sampleFolder();
    const b = sampleFolder();
    expect(a.name).toBe(SAMPLE_FOLDER_NAME);
    expect(a.id).not.toBe(b.id);
    expect(Date.parse(a.createdAt)).not.toBeNaN();
  });
});
