import { describe, expect, it } from "vitest";
import type { LocalIdentity } from "../../lib/local-directory.js";
import { IDENTITY_LABELS, IDENTITY_VIEWS } from "../../lib/section-views.js";
import { identityPageTree } from "./page-tree.js";

const alice: LocalIdentity = {
  id: "local_alice",
  kind: "person",
  name: "Alice",
  enabled: true,
};
const bot: LocalIdentity = {
  id: "local_bot",
  kind: "agent",
  name: "Deploy",
  enabled: true,
};

describe("identity page tree", () => {
  it("turns each Identity tab into a subtree", () => {
    const tree = identityPageTree();
    expect(tree.map((node) => node.label)).toEqual(
      IDENTITY_VIEWS.map((id) => IDENTITY_LABELS[id]),
    );
    expect(tree.find((node) => node.id === "people")?.children).toEqual([]);
  });

  it("places directory records under the tab that shows them", () => {
    const tree = identityPageTree({
      directory: [
        alice,
        bot,
        {
          id: "local_app",
          kind: "application",
          name: "Wiki",
          enabled: true,
        },
        {
          id: "local_org",
          kind: "organization",
          name: "Acme",
          enabled: true,
        },
      ],
      providers: [{ id: "google", label: "Google" }],
      devices: [{ id: "dev_1", name: "Desk laptop" }],
    });
    const leaves = (id: string) =>
      tree.find((node) => node.id === id)?.children.map((node) => node.label);
    expect(leaves("people")).toEqual(["Alice"]);
    expect(leaves("agents")).toEqual(["Deploy"]);
    expect(leaves("service-accounts")).toEqual(["Wiki"]);
    expect(leaves("organization")).toEqual(["Acme"]);
    expect(leaves("providers")).toEqual(["Google"]);
    expect(leaves("devices")).toEqual(["Desk laptop"]);
  });
});
