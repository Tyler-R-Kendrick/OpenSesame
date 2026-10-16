import { z } from "zod";
import { secretHttpFixture } from "./onepassword-http.test-support.js";
import { createOnePasswordConnectBackend } from "./onepassword.js";
import {
  deferred,
  remoteDraft,
  runtimeFixture,
} from "./runtime.test-support.js";

const WriteSchema = z.object({
  title: z.string(),
  category: z.string(),
  fields: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      purpose: z.string().optional(),
      label: z.string().optional(),
      value: z.string(),
    }),
  ),
  urls: z.array(z.object({ href: z.string() })),
});
type RemoteItem = z.infer<typeof WriteSchema> & { id: string; version: number };
export async function backupFixture() {
  const local = await runtimeFixture();
  const records = new Map<string, RemoteItem>();
  let truncate = false;
  let pauseWrite = false;
  const entered = deferred<void>();
  const resume = deferred<void>();
  const server = await secretHttpFixture(async (request) => {
    if (
      request.headers.authorization !== "Bearer runtime-connect-token-fixture"
    )
      return { status: 401 };
    const path = "/v1/vaults/vault/items";
    if (request.path === "/v1/vaults/vault") return { body: '{"id":"vault"}' };
    if (request.path === path && request.method === "GET")
      return { body: JSON.stringify([...records.values()]) };
    if (request.path === path && request.method === "POST") {
      const body = WriteSchema.parse(JSON.parse(request.body));
      const item = { ...body, id: `backup-${records.size + 1}`, version: 1 };
      records.set(item.id, item);
      if (pauseWrite) {
        entered.resolve();
        await resume.promise;
      }
      return { body: JSON.stringify(item) };
    }
    const item = records.get(request.path.slice(path.length + 1));
    if (!item) return { status: 404 };
    const read = structuredClone(item);
    if (truncate)
      for (const field of read.fields)
        if (field.id === "notesPlain") field.value = field.value.slice(0, -1);
    return { body: JSON.stringify(read) };
  });
  const backend = createOnePasswordConnectBackend();
  const session = await backend.authenticate({
    ...remoteDraft(),
    baseUrl: server.url,
  });
  return {
    local,
    server,
    open: { backend, session },
    records,
    truncate() {
      truncate = true;
    },
    pause() {
      pauseWrite = true;
      return { entered: entered.promise, resume: () => resume.resolve() };
    },
    async close() {
      resume.resolve();
      await backend.disconnect(session);
      await server.close();
      await local.close();
    },
  };
}
