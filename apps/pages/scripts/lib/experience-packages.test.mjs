import { describe, expect, it } from "vitest";
import { experiencePackages } from "./experience-packages.mjs";

describe("experience packages", () => {
  it("walks every block when nothing is named", () => {
    for (const value of [undefined, "", " , "]) {
      expect(experiencePackages(value)("@opensesame/pages")).toBe(true);
    }
  });

  it("walks only the named packages' blocks", () => {
    const reached = experiencePackages(
      "@opensesame/pages, @opensesame/database",
    );
    expect(reached("@opensesame/pages")).toBe(true);
    expect(reached("@opensesame/database")).toBe(true);
    expect(reached("@opensesame/app-core")).toBe(false);
  });
});
