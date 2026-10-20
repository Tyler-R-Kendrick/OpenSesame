/** @vitest-environment jsdom */
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { decodeAiImage } from "@opensesame/app-core/lib/ai-connections/image-output.js";
import { imageOwnerFixture } from "@opensesame/app-core/lib/ai-connections/image-owner.test-support.js";
import { OwnedAiImage } from "@opensesame/app-core/lib/ai-connections/owned-image.js";
import { RASTER_FIXTURES } from "@opensesame/app-core/lib/ai-connections/stability-tls.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AiGeneratedImage } from "./AiGeneratedImage.js";
import { previewHost } from "./image-preview.test-support.js";

const teardown: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of teardown.splice(0).reverse()) await close();
});
async function setup() {
  const form = await new Response("x=y", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }).formData();
  vi.stubGlobal("FormData", form.constructor);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  const f = await imageOwnerFixture();
  teardown.push(f.close);
  const host = previewHost();
  teardown.push(host.close);
  const owner = f.prepared.owner.complete(f.image);
  const view = render(<AiGeneratedImage image={owner} />);
  await waitFor(() => expect(host.pending).toHaveLength(1));
  return { ...f, host, owner, view };
}
it("reveals only decoded local pixels and downloads the same owned URL without fetching another route", async () => {
  const f = await setup();
  const captures = f.captures();
  expect(screen.queryByRole("img", { name: "Generated artwork" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
  expect(f.host.urls).toHaveLength(1);
  expect(f.host.urls[0].type).toBe("image/png");
  await act(async () => f.host.pending[0].resolve());
  expect(
    screen.getByRole("img", { name: "Generated artwork" }).getAttribute("src"),
  ).toBe("blob:owned-image-1");
  fireEvent.click(screen.getByRole("button", { name: "Download image" }));
  expect(f.host.clicked).toEqual([
    { href: "blob:owned-image-1", filename: "generated-image.png" },
  ]);
  expect(f.captures()).toBe(captures);
  expect(f.host.revoked).toEqual([]);
  f.view.unmount();
  expect(f.host.revoked).toEqual(["blob:owned-image-1"]);
  expect(() => f.image.copyBytes()).toThrow();
});
it.each(["unmount", "caller", "route", "feature", "lock", "credential"])(
  "withdraws pending decode on %s and never reveals a stale image or download",
  async (change) => {
    const f = await setup();
    await act(async () => {
      if (change === "unmount") f.view.unmount();
      else if (change === "caller") f.caller.abort();
      else if (change === "route") f.withdrawRoute();
      else if (change === "feature") f.withdrawFeature();
      else if (change === "lock") vaultStore.lock();
      else {
        if (f.token.method.type !== "token") throw new Error("Expected token");
        await vaultStore.saveItem({
          ...f.token,
          method: { ...f.token.method, token: "replaced-credential" },
        });
      }
    });
    await waitFor(() => expect(f.host.revoked).toEqual(["blob:owned-image-1"]));
    await act(async () => f.host.pending[0].resolve());
    expect(screen.queryByRole("img", { name: "Generated artwork" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
    expect(f.host.clicked).toEqual([]);
    expect(() => f.image.copyBytes()).toThrow();
  },
);
it.each(["invalid-codec", "dimension-mismatch"])(
  "refuses %s before ready or download and revokes bytes/URL",
  async (failure) => {
    const f = await setup();
    await act(async () => {
      if (failure === "invalid-codec")
        f.host.pending[0].reject(new Error("Decoder refused bytes"));
      else {
        Object.defineProperty(f.host.pending[0].image, "naturalWidth", {
          value: 3,
        });
        f.host.pending[0].resolve();
      }
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be decoded",
    );
    expect(screen.queryByRole("img", { name: "Generated artwork" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
    expect(f.host.revoked).toEqual(["blob:owned-image-1"]);
    expect(() => f.image.copyBytes()).toThrow();
  },
);
it("revokes a ready preview immediately when caller ownership ends", async () => {
  const f = await setup();
  await act(async () => f.host.pending[0].resolve());
  const button = screen.getByRole("button", { name: "Download image" });
  act(() => f.caller.abort());
  fireEvent.click(button);
  expect(f.host.clicked).toEqual([]);
  expect(f.host.revoked).toEqual(["blob:owned-image-1"]);
  expect(screen.queryByRole("img", { name: "Generated artwork" })).toBeNull();
});

it("replaces a pending image without allowing its late decode to publish or retaining either URL after unmount", async () => {
  const f = await setup();
  const prepared = await OwnedAiImage.prepare(f.saved.connectionId, {
    signal: f.caller.signal,
    assertCurrent() {},
  });
  const raster = decodeAiImage(RASTER_FIXTURES.png, "image/png", "");
  const replacement = prepared.owner.complete(raster);
  f.view.rerender(<AiGeneratedImage image={replacement} />);
  await waitFor(() => expect(f.host.pending).toHaveLength(2));
  expect(f.host.revoked).toEqual(["blob:owned-image-1"]);
  expect(() => f.image.copyBytes()).toThrow();
  await act(async () => f.host.pending[0].resolve());
  expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
  await act(async () => f.host.pending[1].resolve());
  expect(
    screen.getByRole("img", { name: "Generated artwork" }).getAttribute("src"),
  ).toBe("blob:owned-image-2");
  f.view.unmount();
  expect(f.host.revoked).toEqual(["blob:owned-image-1", "blob:owned-image-2"]);
  expect(() => raster.copyBytes()).toThrow();
});
