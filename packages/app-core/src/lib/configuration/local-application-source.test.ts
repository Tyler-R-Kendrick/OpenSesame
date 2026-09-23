import { describe, expect, it } from "vitest";
import { commitLocalApplicationSource } from "./local-application-source.js";

const SOURCE = `# app
name: payroll
redirectUris:
  - https://payroll.example/cb
`;

describe("commitLocalApplicationSource", () => {
  it("does not call configure for a comment-only edit", () => {
    let calls = 0;
    const result = commitLocalApplicationSource(
      {
        revision: () => 3,
        configure: () => {
          calls += 1;
        },
      },
      {
        previousSource: SOURCE,
        source: `${SOURCE}# still payroll\n`,
        expectedRevision: 3,
      },
    );
    expect(result.status).toBe("applied_durable");
    expect(calls).toBe(0);
    expect(result.message).toContain("not invalidated");
  });

  it("calls configure when a semantic field changes", () => {
    let calls = 0;
    const result = commitLocalApplicationSource(
      {
        revision: () => 3,
        configure: () => {
          calls += 1;
        },
      },
      {
        previousSource: SOURCE,
        source: SOURCE.replace("payroll", "billing"),
        expectedRevision: 3,
      },
    );
    expect(result.status).toBe("applied_durable");
    expect(calls).toBe(1);
  });
});
