import { describe, expect, it } from "vitest";
import { classifyIdentity, identityStatusLabel } from "./planes.js";

describe("plane status", () => {
  it("does not treat a missing session as Identity down when the API answers", () => {
    expect(classifyIdentity(false, "reachable")).toBe("none");
    expect(classifyIdentity(true, "unreachable")).toBe("connected");
    expect(classifyIdentity(false, "unreachable")).toBe("down");
  });

  it("labels the identity plane", () => {
    expect(identityStatusLabel("connected")).toBe("Identity connected");
    expect(identityStatusLabel("none")).toBe("No identity session");
    expect(identityStatusLabel("down")).toBe("Identity down");
  });
});
