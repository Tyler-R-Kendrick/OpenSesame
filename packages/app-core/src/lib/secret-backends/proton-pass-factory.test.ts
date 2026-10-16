import { afterEach, describe, expect, it } from "vitest";
import { createSecretBackend } from "./factory.js";
import { secretBackendDraft } from "./presets.js";
import { protonFixture } from "./proton-pass-http.fixture.js";
import { bindSecretBackendTransport } from "./transport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const fixture = await protonFixture();
  const unbind = bindSecretBackendTransport(fixture.transport);
  cleanups.push(async () => {
    unbind();
    await fixture.close();
  });
  const backend = await createSecretBackend("proton-pass");
  const config = {
    ...secretBackendDraft("proton-pass"),
    ...fixture.config,
    mode: "proton-pass" as const,
    appVersion: "web-opensesame@2.0.0",
    clientId: "unused-client-ID",
  };
  return { ...fixture, backend, config };
}

describe("native Proton common factory dispatch", () => {
  it("uses actual public config.appVersion through the common fenced port and performs encrypted backup CRUD", async () => {
    const f = await setup();
    const session = await f.backend.authenticate(f.config);
    if (!f.backend.createItem || !f.backend.updateItem || !f.backend.deleteItem)
      throw new Error("Native factory omitted encrypted item mutations");
    const item = await f.backend.createItem(
      {
        name: "Factory backup",
        notes: "encrypted snapshot",
        secret: "",
        kind: "note",
      },
      session,
    );
    expect(await f.backend.getNotes(item.id, session)).toBe(
      "encrypted snapshot",
    );
    await f.backend.updateItem(
      item.id,
      { name: item.name, notes: "updated snapshot", secret: "", kind: "note" },
      session,
    );
    expect(await f.backend.getNotes(item.id, session)).toBe("updated snapshot");
    await f.backend.deleteItem(item.id, session);
    expect(await f.backend.listItems(session)).toEqual([]);
    expect(
      f.state.requests.every(
        (r) => r.headers["x-pm-appversion"] === f.config.appVersion,
      ),
    ).toBe(true);
    expect(
      f.state.requests.some(
        (r) => r.headers["x-pm-appversion"] === f.config.clientId,
      ),
    ).toBe(false);
  });

  it("refuses missing explicit application header before authentication and never substitutes clientId", async () => {
    const f = await setup();
    await expect(
      f.backend.authenticate({
        ...f.config,
        appVersion: "",
        clientId: "web-opensesame@9.0.0",
      }),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(f.state.requests).toEqual([]);
  });

  it("keeps the approved owner fence on the native factory instance", async () => {
    const f = await setup();
    f.controller.abort();
    await expect(f.backend.authenticate(f.config)).rejects.toThrow();
    expect(f.state.requests).toEqual([]);
  });
});
