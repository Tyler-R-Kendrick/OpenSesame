import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appLinkPaths,
  associationFiles,
  associationInputs,
  writeAssociations,
} from "./write-authenticator-associations.mjs";

const read = (path) =>
  readFile(new URL(path, import.meta.url), "utf8").then((text) => text);

const FINGERPRINT = Array.from({ length: 32 }, () => "AB").join(":");
const VALID = {
  OPENSESAME_IOS_APP_IDENTIFIER: "ABCDE12345.dev.example.authenticator",
  OPENSESAME_ANDROID_PACKAGE_NAME: "dev.example.authenticator",
  OPENSESAME_ANDROID_SHA256_CERT_FINGERPRINTS: ` ${FINGERPRINT} , ${FINGERPRINT.toLowerCase()} `,
};

let scratch = null;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

describe("association inputs", () => {
  it("is null when none of the three is set", () => {
    expect(associationInputs({})).toBeNull();
    expect(
      associationInputs({ OPENSESAME_ANDROID_SHA256_CERT_FINGERPRINTS: " , " }),
    ).toBeNull();
  });

  it("takes all three, trimmed", () => {
    expect(associationInputs(VALID)).toEqual({
      appleAppId: "ABCDE12345.dev.example.authenticator",
      androidPackage: "dev.example.authenticator",
      androidFingerprints: [FINGERPRINT, FINGERPRINT.toLowerCase()],
    });
  });

  it("fails closed on a partial set", () => {
    for (const missing of Object.keys(VALID)) {
      const partial = { ...VALID, [missing]: "" };
      expect(() => associationInputs(partial), missing).toThrow(/together/);
    }
  });

  it("fails closed on a value of the wrong shape", () => {
    const bad = [
      ["OPENSESAME_IOS_APP_IDENTIFIER", "abcde12345.dev.example"],
      ["OPENSESAME_IOS_APP_IDENTIFIER", "ABCDE12345"],
      ["OPENSESAME_ANDROID_PACKAGE_NAME", "authenticator"],
      ["OPENSESAME_ANDROID_PACKAGE_NAME", "dev.9example"],
      ["OPENSESAME_ANDROID_SHA256_CERT_FINGERPRINTS", "AB:CD"],
      ["OPENSESAME_ANDROID_SHA256_CERT_FINGERPRINTS", `${FINGERPRINT},zz`],
    ];
    for (const [name, value] of bad) {
      expect(
        () => associationInputs({ ...VALID, [name]: value }),
        value,
      ).toThrow();
    }
  });
});

describe("the claimed paths come from spec/config/ceremony-routes.json", () => {
  it("claims every route whose kinds name an app link, and only those", async () => {
    const spec = JSON.parse(
      await read("../../../spec/config/ceremony-routes.json"),
    );
    const paths = appLinkPaths(spec);
    expect(paths).toEqual(["/invoke/*"]);
    const { invoke } = spec.routes;
    expect(Object.values(invoke.kinds).every((kind) => kind.app)).toBe(true);
    expect(`${invoke.path.slice(0, invoke.path.indexOf("{"))}*`).toBe(paths[0]);
  });

  it("matches the Android app-link filter's path prefix (drift)", async () => {
    const spec = JSON.parse(
      await read("../../../spec/config/ceremony-routes.json"),
    );
    const manifest = await read(
      "../../android/android/app/src/main/AndroidManifest.xml",
    );
    const prefixes = [
      ...manifest.matchAll(/android:pathPrefix="([^"]+)"/g),
    ].map((match) => `${match[1]}*`);
    expect(prefixes).toEqual(appLinkPaths(spec));
  });
});

describe("the written files", () => {
  it("name the app, the fingerprints and the spec's paths", () => {
    const files = associationFiles(associationInputs(VALID), ["/invoke/*"]);
    expect(JSON.parse(files["apple-app-site-association"])).toEqual({
      applinks: {
        details: [
          {
            appIDs: ["ABCDE12345.dev.example.authenticator"],
            components: [
              {
                "/": "/invoke/*",
                comment: "OpenSesame authenticator requests",
              },
            ],
          },
        ],
      },
    });
    expect(JSON.parse(files["assetlinks.json"])).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "dev.example.authenticator",
          sha256_cert_fingerprints: [FINGERPRINT, FINGERPRINT.toLowerCase()],
        },
      },
    ]);
  });

  it("writes both into dist/.well-known, or nothing at all", async () => {
    scratch = await mkdtemp(join(tmpdir(), "os-wellknown-"));
    expect(await writeAssociations(scratch, {})).toEqual([]);
    expect(await readdir(scratch)).toEqual([]);
    expect(await writeAssociations(scratch, VALID)).toEqual([
      "apple-app-site-association",
      "assetlinks.json",
    ]);
    expect((await readdir(join(scratch, ".well-known"))).sort()).toEqual([
      "apple-app-site-association",
      "assetlinks.json",
    ]);
    await expect(
      writeAssociations(scratch, {
        ...VALID,
        OPENSESAME_IOS_APP_IDENTIFIER: "",
      }),
    ).rejects.toThrow(/together/);
  });
});

describe("where it runs", () => {
  it("runs from the Vercel build, after the Pages build", async () => {
    const vercel = JSON.parse(await read("../vercel.json"));
    const steps = vercel.buildCommand.split("&&").map((step) => step.trim());
    const at = steps.findIndex((step) =>
      step.endsWith("apps/pages/scripts/write-authenticator-associations.mjs"),
    );
    const build = steps.findIndex((step) => step.includes("turbo run build"));
    expect(at).toBeGreaterThan(build);
    expect(build).toBeGreaterThanOrEqual(0);
  });

  it("never from the GitHub Pages build", async () => {
    const workflow = await read("../../../.github/workflows/deploy-pages.yml");
    const pkg = await read("../package.json");
    expect(workflow).not.toContain("write-authenticator-associations");
    expect(pkg).not.toContain("write-authenticator-associations");
  });

  it("the SPA rewrite leaves /.well-known/ to the filesystem", async () => {
    const vercel = JSON.parse(await read("../vercel.json"));
    for (const { source } of vercel.rewrites) {
      const pattern = new RegExp(`^${source}$`);
      expect(pattern.test("/.well-known/assetlinks.json"), source).toBe(false);
      expect(
        pattern.test("/.well-known/apple-app-site-association"),
        source,
      ).toBe(false);
      expect(pattern.test("/invoke/mfa"), source).toBe(true);
    }
    const header = vercel.headers.find(
      (entry) => entry.source === "/.well-known/apple-app-site-association",
    );
    expect(header?.headers).toContainEqual({
      key: "Content-Type",
      value: "application/json",
    });
  });
});
