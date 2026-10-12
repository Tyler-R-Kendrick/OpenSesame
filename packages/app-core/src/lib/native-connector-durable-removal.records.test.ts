import {
  type BoundaryValue,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { openOriginFile } from "./at-rest/origin-files.js";
import { DEVICE_CONNECTOR_KEYS } from "./device-connector-records.js";
import { kvForgetAll, kvHydrate } from "./kv.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "./native-connector-lifecycle.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";

const providerId = "sealed-removal";
const fingerprint = "d".repeat(64);
const classification = {
  publicParameters: [],
  privateCredentials: ["api_key"],
};
const atomicFile = "opensesame-pages-opensesame.self-hosted-connectors.v1.json";
let dispose = () => {};

type Gate = { promise: Promise<void>; resolve: () => void };

function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

/** Real KV encryption and commit logic, with a simulated atomic OPFS writable. */
function originFiles(
  beforeClose: (name: string, sealed: string) => Promise<void>,
) {
  const files = new Map<string, string>();
  const root = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create)
          throw new DOMException("missing", "NotFoundError");
        files.set(name, "");
      }
      return {
        getFile: async () => new Blob([files.get(name) ?? ""]),
        async createWritable() {
          let staged = "";
          return {
            async write(sealed: string) {
              staged = sealed;
            },
            async close() {
              await beforeClose(name, staged);
              files.set(name, staged);
            },
          };
        },
      };
    },
  };
  const handle: FileSystemDirectoryHandle = overlapCast(root);
  return { files, port: async () => handle };
}

async function save(connectionId: string) {
  const accessToken = `private-${connectionId}`;
  return saveNativeConnector(
    {
      connectionId,
      configuration: {
        version: 1,
        providerId,
        method: "api-key",
        displayName: connectionId,
        icon: "",
        parameters: {},
        requestedScopes: {},
        targetIds: {},
        fingerprint,
      },
      runtime: {
        ...emptyNativeRuntime(),
        verifiedAt: 100,
        grants: [
          {
            actor: "app",
            label: "API key",
            permissionState: "unknown",
            grantedScopes: [],
            expiresAt: null,
            needsReauth: false,
          },
        ],
      },
      privateState: {
        ...emptyNativePrivate(),
        credentials: { api_key: accessToken },
        verification: { fingerprint, verifiedAt: 100, kind: "provider" },
        grants: {
          app: {
            providerId,
            actor: "app",
            fingerprint,
            kind: "api-key",
            accessToken,
            expiresAt: null,
            scopes: null,
          },
        },
      },
    },
    classification,
  );
}

async function coldHydrate() {
  kvForgetAll();
  forgetAtRestKeyForTest();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
}

beforeEach(kvForgetAll);
afterEach(() => {
  dispose();
  configureHost(createTestHost());
  kvForgetAll();
  forgetAtRestKeyForTest();
});

it("awaits the sealed tombstone close, rejects stale edits, and keeps another connection after cold hydration", async () => {
  const closing = gate();
  const release = gate();
  const disk = originFiles(async (name, sealed) => {
    if (name !== atomicFile) return;
    const plaintext = await openOriginFile(name, sealed);
    if (!plaintext) throw new Error("Fixture seal did not open");
    const records: BoundaryValue = JSON.parse(plaintext);
    if (!isJsonObject(records) || records.removed !== null) return;
    closing.resolve();
    await release.promise;
  });
  const locks = webLocksDouble();
  configureHost(
    createTestHost({
      originFiles: disk.port,
      locks: overlapCast(locks),
    }),
  );
  dispose = registerNativeProviderCleanup(providerId, {
    classification: () => classification,
    cleanup: async () => "local-credential-forgotten",
  });
  const first = await save("removed");
  await save("retained");
  const stale = { revision: first.revision, fingerprint };
  let completed = false;
  const removal = removeNativeConnectorWithCleanup(first.connectionId).then(
    (result) => {
      completed = true;
      return result;
    },
  );
  await closing.promise;
  expect(completed).toBe(false);
  expect(readNativeConnector(first.connectionId)).not.toBeNull();
  const staleEdit = updateNativeConnector(
    first.connectionId,
    stale,
    classification,
    (record) => {
      record.configuration.displayName = "Stale tab";
      return record;
    },
  );
  const refused = expect(staleEdit).rejects.toThrow("not found");
  release.resolve();
  await expect(removal).resolves.toBe(true);
  await refused;
  const sealed = disk.files.get(atomicFile) ?? "";
  expect(sealed).not.toContain("private-removed");
  expect(sealed).not.toContain("private-retained");
  await coldHydrate();
  expect(readNativeConnector(first.connectionId)).toBeNull();
  expect(readNativeConnector("retained")?.status).toBe("connected");
  expect(
    loadNativeConnectorRecord("retained")?.privateState.credentials.api_key,
  ).toBe("private-retained");
  expect(locks.requested).toContain("opensesame:device-connectors");
  expect(locks.peak()).toBe(1);
});
