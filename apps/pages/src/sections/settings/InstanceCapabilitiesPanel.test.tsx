/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inTray } from "../../components/tray.test-support.js";
import { instancePanelSeams } from "./InstanceCapabilitiesPanel.js";
import {
  installPanelFixture,
  renderPanel,
} from "./capabilities-panel.test-support.js";

installDoublePorts();
installPanelFixture();

const original = { ...instancePanelSeams };
const SENTENCE = "The policy file could not be written.";

beforeEach(() => {
  clearNotices();
});

afterEach(() => {
  Object.assign(instancePanelSeams, original);
  clearNotices();
});

function head(): HTMLElement {
  const found = screen
    .getByTestId("instance-capabilities-panel")
    .querySelector<HTMLElement>(".capsection__head");
  if (found === null) throw new Error("no section head");
  return found;
}

describe("the instance policy when a preset is refused", () => {
  it("marks the section head with the sentence and trays it", async () => {
    instancePanelSeams.save = async () => {
      throw new Error(SENTENCE);
    };
    renderPanel();
    fireEvent.click(screen.getByTestId("purpose-card-personal"));
    await waitFor(() =>
      expect(within(head()).getByRole("img", { name: SENTENCE })).toBeTruthy(),
    );
    await waitFor(() => expect(inTray(SENTENCE)).toBe(true));
  });

  it("wears no mark and raises nothing when the preset is stored", async () => {
    let saved = 0;
    instancePanelSeams.save = async () => {
      saved += 1;
    };
    renderPanel();
    fireEvent.click(screen.getByTestId("purpose-card-personal"));
    await waitFor(() => expect(saved).toBe(1));
    expect(within(head()).queryByRole("img", { name: SENTENCE })).toBeNull();
    expect(listNotices()).toHaveLength(0);
  });
});
