/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import type { LocalPasskey } from "@opensesame/app-core/lib/local-credentials.js";
import {
  Clock,
  device,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { installPanelFixture } from "../../sections/settings/settings-panels.test-support.js";
import { type Person, UnlockCircleFields } from "./UnlockCircleFields.js";
import { UnlockCirclePanel, unlockCircleSeams } from "./UnlockCirclePanel.js";
import {
  declareTargets,
  deskOf,
  serveDesk,
} from "./trusted-contacts.test-support.js";

installDoublePorts();
installPanelFixture();

const original = { ...unlockCircleSeams };
let restoreDesk: () => void = () => undefined;
let undeclare: () => void = () => undefined;

afterEach(() => {
  cleanup();
  restoreDesk();
  undeclare();
  Object.assign(unlockCircleSeams, original);
});

describe("a selected contact whose passkey was revoked", () => {
  it("can be unchecked instead of trapping the circle on save", async () => {
    const person: Person = {
      id: `local_${crypto.randomUUID()}`,
      name: "Ada",
      hasPasskey: false,
    };
    function Harness() {
      const [selected, setSelected] = useState<readonly string[]>([person.id]);
      return (
        <UnlockCircleFields
          name="Family"
          setName={() => undefined}
          people={[person]}
          selected={selected}
          setSelected={setSelected}
          maximum={1}
          wanted={1}
          setThreshold={() => undefined}
          onEnroll={() => undefined}
          enrolling={null}
        />
      );
    }
    render(<Harness />);
    const box = screen.getByRole("checkbox", { name: "Ada" });
    expect(box).toHaveProperty("disabled", false);
    await userEvent.click(box);
    expect(box).toHaveProperty("checked", false);
  });
});

describe("the trusted-contact circle from the directory", () => {
  it("lists directory people, enrolls a passkey in place, and saves a threshold", async () => {
    undeclare = declareTargets();
    const desk = await deskOf(device(new Clock()));
    restoreDesk = serveDesk(desk);
    const ada = `local_${crypto.randomUUID()}`;
    const ben = `local_${crypto.randomUUID()}`;
    let keys: LocalPasskey[] = [];
    let written: {
      name: string;
      threshold: number;
      memberIds: readonly string[];
    } | null = null;
    unlockCircleSeams.directory = async () => ({
      version: 2,
      revision: 0,
      entries: [
        { id: ada, kind: "person", name: "Ada", enabled: true },
        { id: ben, kind: "person", name: "Ben", enabled: true },
      ],
      memberships: [],
    });
    unlockCircleSeams.passkeys = async () => keys;
    unlockCircleSeams.enroll = async (_tomb, principalId) => {
      keys = [
        ...keys,
        {
          principalId,
          credentialId: `credential-${principalId}`,
          publicKeyB64: "A",
          counter: 0,
          createdAt: 1,
        },
      ];
      return {
        credentialId: `credential-${principalId}`,
        prfSupported: false,
        vaultOffer: null,
      };
    };
    unlockCircleSeams.writePolicy = async (_tomb, next) => {
      written = next;
      return { version: 1, ...next, createdAt: new Date().toISOString() };
    };

    const user = userEvent.setup();
    render(<UnlockCirclePanel />);
    await screen.findByRole("button", { name: "Start a circle" });
    await user.click(screen.getByRole("button", { name: "Start a circle" }));

    const adaBox = await screen.findByRole("checkbox", { name: "Ada" });
    expect(adaBox).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Enroll a passkey for Ada" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Enroll a passkey for Ada" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Ada" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Enroll a passkey for Ben" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Ben" })).toHaveProperty(
        "disabled",
        false,
      ),
    );

    for (const name of ["Ada", "Ben"]) {
      const box = screen.getByRole("checkbox", { name });
      if (!box.matches(":checked")) await user.click(box);
    }
    await user.selectOptions(
      screen.getByLabelText("Required approvals"),
      "2 of 2",
    );
    await user.click(screen.getByRole("button", { name: "Save the circle" }));
    await waitFor(() => expect(written).not.toBeNull());
    expect(written).toMatchObject({ threshold: 2, memberIds: [ada, ben] });
  });
});
