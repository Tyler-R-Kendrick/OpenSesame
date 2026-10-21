/** @vitest-environment jsdom */
import {
  BYO_CONNECTION_DEFINITION,
  byoConnectionSeams,
} from "@opensesame/app-core/lib/byo-connections.js";
import type { Connection } from "@opensesame/app-core/lib/connections.js";
import { deviceConnectorView } from "@opensesame/app-core/lib/device-connector-view.js";
import type { VaultItem } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ByoConnectionPanel } from "./ByoConnectionPanel.js";

const original = { ...byoConnectionSeams };
const saveItem = vi.fn<(item: VaultItem) => Promise<void>>(
  async () => undefined,
);
const saveConnector = vi.fn<
  (input: {
    providerId: string;
    displayName: string;
    scopes: string[];
    fields: Record<string, string>;
    secrets: Record<string, string>;
  }) => Promise<Connection>
>(async () =>
  deviceConnectorView({
    connectionId: "conn_local_byo",
    providerId: "byo-connection",
    displayName: "Acme",
    scopes: [],
    fields: {},
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  }),
);

beforeEach(() => {
  saveItem.mockClear();
  saveConnector.mockClear();
  Object.assign(byoConnectionSeams, {
    ensureDefinition: async () => BYO_CONNECTION_DEFINITION,
    saveItem,
    saveConnector,
  });
});

afterEach(() => {
  cleanup();
  Object.assign(byoConnectionSeams, original);
});

describe("BYO connection form", () => {
  it("offers the four methods and writes a vault item instead of the connection", async () => {
    const onSaved = vi.fn();
    const onFlash = vi.fn();
    const onClose = vi.fn();
    render(
      <ByoConnectionPanel
        open
        onClose={onClose}
        onSaved={onSaved}
        onFlash={onFlash}
      />,
    );
    expect(screen.getByRole("radio", { name: "OAuth" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Basic auth" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "API key" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "SAML" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Connection name"), {
      target: { value: "Acme" },
    });
    fireEvent.change(screen.getByLabelText("Service"), {
      target: { value: "Acme API" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "API key" }));
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://api.acme.test" },
    });
    fireEvent.change(screen.getByLabelText("API key value"), {
      target: { value: "secret-api-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalledOnce());

    const item = saveItem.mock.calls[0]?.[0];
    expect(item?.kind).toBe("typed");
    if (item?.kind !== "typed") throw new Error("Expected a typed item");
    expect(item.values.credential).toBe("secret-api-key");
    expect(saveConnector).toHaveBeenCalledOnce();
    expect(JSON.stringify(saveConnector.mock.calls[0]?.[0])).not.toContain(
      "secret-api-key",
    );
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onFlash).toHaveBeenCalledWith({
      tone: "ok",
      text: "Connection saved in this vault.",
    });
  });

  it("will not call the writer with a missing API key", () => {
    render(
      <ByoConnectionPanel
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onFlash={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Connection name"), {
      target: { value: "Acme" },
    });
    fireEvent.change(screen.getByLabelText("Service"), {
      target: { value: "Acme API" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "API key" }));
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://api.acme.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(saveItem).not.toHaveBeenCalled();
  });
});
