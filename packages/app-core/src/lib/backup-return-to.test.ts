/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { githubBackupReturnTo } from "./backup.js";

describe("githubBackupReturnTo", () => {
  it("points GitHub App redirects back at this origin's settings route", () => {
    expect(githubBackupReturnTo()).toBe(`${window.location.origin}/settings`);
  });
});
