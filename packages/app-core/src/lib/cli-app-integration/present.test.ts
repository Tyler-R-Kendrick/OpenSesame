import { describe, expect, it } from "vitest";
import {
  presentCliAuthorizeRequest,
  terminalSessionLabel,
} from "./present.js";

describe("cli app integration presentation", () => {
  it("shortens long terminal session ids", () => {
    expect(terminalSessionLabel("term-abcdefghijklmnop")).toBe("term-a…mnop");
  });

  it("parses op:// references into item and field", () => {
    const view = presentCliAuthorizeRequest({
      requestId: "clr_1",
      terminalSessionId: "term-a",
      verb: "read",
      reference: "op://personal/login.example/password",
      createdAtMs: 0,
    });
    expect(view.commandLabel).toBe("Read a secret");
    expect(view.targetLine).toBe("personal/login.example");
    expect(view.fieldLine).toBe("password");
  });
});
