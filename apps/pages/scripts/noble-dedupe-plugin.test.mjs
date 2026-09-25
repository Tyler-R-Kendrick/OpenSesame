import { describe, expect, it, vi } from "vitest";
import { nobleCopies, nobleDedupe } from "./noble-dedupe-plugin.mjs";

const PNPM = "/repo/node_modules/.pnpm";
const PQ = `${PNPM}/@noble+post-quantum@0.5.4/node_modules/@noble/post-quantum/ml-kem.js`;
const AGE = `${PNPM}/age-encryption@0.3.1/node_modules/age-encryption/dist/index.js`;
const NEW = `${PNPM}/@noble+curves@2.4.0/node_modules/@noble/curves/utils.js`;

function context(resolved) {
  const resolve = vi.fn(async (source, importer) => {
    if (source === "age-encryption") return { id: AGE };
    return importer === AGE ? { id: resolved } : null;
  });
  return { resolve, error: vi.fn() };
}

describe("noble dedupe (one @noble/curves and @noble/hashes 2.x)", () => {
  it("resolves post-quantum's noble imports from age-encryption's tree", async () => {
    const plugin = nobleDedupe();
    const ctx = context(NEW);
    const out = await plugin.resolveId.call(
      ctx,
      "@noble/curves/utils.js",
      PQ,
      {},
    );
    expect(out).toEqual({ id: NEW });
    expect(ctx.resolve).toHaveBeenLastCalledWith(
      "@noble/curves/utils.js",
      AGE,
      expect.objectContaining({ skipSelf: true }),
    );
  });

  it("leaves every other importer and specifier alone", async () => {
    const plugin = nobleDedupe();
    const ctx = context(NEW);
    expect(
      await plugin.resolveId.call(ctx, "@noble/curves/utils.js", AGE, {}),
    ).toBeNull();
    expect(
      await plugin.resolveId.call(ctx, "@noble/ciphers/aes.js", PQ, {}),
    ).toBeNull();
    expect(ctx.resolve).not.toHaveBeenCalled();
  });

  it("keeps the pinned copy unless the target is the same major line", async () => {
    const plugin = nobleDedupe();
    const old = `${PNPM}/@noble+curves@1.9.1/node_modules/@noble/curves/utils.js`;
    expect(
      await plugin.resolveId.call(
        context(old),
        "@noble/curves/utils.js",
        PQ,
        {},
      ),
    ).toBeNull();
  });

  it("refuses a bundle that carries two 2.x copies", () => {
    const plugin = nobleDedupe();
    const ctx = context(NEW);
    const chunk = (ids) => ({
      type: "chunk",
      modules: Object.fromEntries(ids.map((id) => [id, {}])),
    });
    plugin.generateBundle.call(ctx, {}, { a: chunk([NEW]) });
    expect(ctx.error).not.toHaveBeenCalled();
    plugin.generateBundle.call(
      ctx,
      {},
      {
        a: chunk([NEW]),
        b: chunk([NEW.replace("2.4.0", "2.0.1")]),
      },
    );
    expect(ctx.error).toHaveBeenCalledOnce();
    expect(
      nobleCopies([NEW, NEW.replace("curves@2.4.0", "hashes@2.4.0")]),
    ).toEqual(
      new Map([
        ["curves", new Set(["2.4.0"])],
        ["hashes", new Set(["2.4.0"])],
      ]),
    );
  });
});
