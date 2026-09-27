import { type Folder, createItem } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_FOLDER_NAME } from "../../lib/vault/sample.js";
import {
  type SampleStorePort,
  planSampleLoad,
  pressSampleKey,
  sampleCount,
  sampleKey,
} from "./sample-model.js";

function port(): SampleStorePort {
  return {
    applyImport: vi.fn(async () => 7),
    removeSample: vi.fn(async () => undefined),
  };
}

const SAMPLE_FOLDER: Folder = {
  id: "fld_samples",
  name: SAMPLE_FOLDER_NAME,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("sampleKey", () => {
  it("offers a load while the vault holds no sample item", () => {
    expect(sampleKey([createItem("login", "Real")])).toEqual({
      action: "load",
      count: 0,
      label: "Load sample data",
    });
  });

  it("offers one removal of every sample item, counted", () => {
    const one = { ...createItem("login", "Demo"), sample: true };
    expect(sampleKey([one, createItem("note", "Real")])).toEqual({
      action: "remove",
      count: 1,
      label: "Remove 1 sample item",
    });
    const trashed = { ...one, id: "b", deletedAt: "2026-01-02T00:00:00Z" };
    expect(sampleCount([one, trashed])).toBe(2);
    expect(sampleKey([one, trashed]).label).toBe("Remove 2 sample items");
  });
});

describe("planSampleLoad", () => {
  it("makes a Sample data folder and badges every item it writes", () => {
    const plan = planSampleLoad([]);
    expect(plan.newFolders).toHaveLength(1);
    expect(plan.newFolders[0]?.name).toBe(SAMPLE_FOLDER_NAME);
    expect(plan.items).toHaveLength(7);
    for (const item of plan.items) {
      expect(item.sample).toBe(true);
      expect(item.folderId).toBe(plan.newFolders[0]?.id);
    }
  });

  it("reuses a Sample data folder that is already there", () => {
    const plan = planSampleLoad([SAMPLE_FOLDER]);
    expect(plan.newFolders).toEqual([]);
    expect(plan.items.every((item) => item.folderId === "fld_samples")).toBe(
      true,
    );
  });
});

describe("pressSampleKey", () => {
  it("loads through one import write", async () => {
    const store = port();
    await pressSampleKey(sampleKey([]), [], store);
    expect(store.applyImport).toHaveBeenCalledTimes(1);
    expect(store.removeSample).not.toHaveBeenCalled();
  });

  it("removes through the store's one sample removal", async () => {
    const store = port();
    const key = sampleKey([{ ...createItem("login", "Demo"), sample: true }]);
    await pressSampleKey(key, [SAMPLE_FOLDER], store);
    expect(store.removeSample).toHaveBeenCalledTimes(1);
    expect(store.applyImport).not.toHaveBeenCalled();
  });
});
