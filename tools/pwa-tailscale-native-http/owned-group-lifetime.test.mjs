import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nativePreparationCommand } from "./prepare-distribution.mjs";
const repository = fileURLToPath(new URL("../..", import.meta.url));
const pause = (ms) => new Promise((accept) => setTimeout(accept, ms));

// Independent single-PID observation: do not reuse the production group enumerator.
async function identity(pid) {
  try {
    const fields = (await readFile(`/proc/${pid}/stat`, "utf8"))
      .split(") ")[1]
      .split(" ");
    return {
      state: fields[0],
      parent: Number(fields[1]),
      group: Number(fields[2]),
      birth: fields[19],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
const active = (info) => info !== null && !["Z", "X", "x"].includes(info.state);
async function fixture(t, { natural = false, stubbornLeader = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "native-owned-lifetime-"));
  const tools = join(root, "tools/pwa-tailscale-native-http");
  const work = join(
    root,
    ".cache/pwa-tailscale-native-http/work",
    randomUUID(),
  );
  const bin = join(root, "bin");
  await cp(join(repository, "tools/pwa-tailscale-native-http"), tools, {
    recursive: true,
  });
  await symlink(
    join(repository, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  await mkdir(join(work, "tmp"), { recursive: true });
  await mkdir(bin);
  const ready = join(root, "ready.json");
  const source = join(root, "source.fixture");
  const compiler = join(root, "compiler.fixture");
  const bytes = Buffer.from(
    "owned process lifetime fixture, not source or compiler proof",
  );
  await writeFile(source, bytes);
  await writeFile(compiler, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    join(tools, "source.json"),
    JSON.stringify({
      source: { archiveSha256: sha, criticalFiles: [] },
      compiler: { archiveSha256: sha, criticalFiles: [] },
    }),
  );
  const script = `#!${process.execPath}
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access,writeFile} from 'node:fs/promises';
const ready=${JSON.stringify(ready)};
try{await access(ready);process.exit(1)}catch{}
${stubbornLeader ? 'process.on("SIGTERM",()=>{});' : ""}
const child=spawn('/bin/sh',['-c','trap "" TERM; printf ready; exec /bin/sleep 30'],{stdio:['ignore','pipe','ignore']});
await once(child.stdout,'data');
const record=JSON.stringify({leader:process.pid,child:child.pid});
await writeFile(ready,record);console.log(record);
${natural ? "process.exit(0);" : "await new Promise(()=>{});"}
`;
  await writeFile(join(bin, "tar"), script, { mode: 0o700 });
  const f = { root, tools, work, bin, ready, source, compiler, member: null };
  t.after(async () => {
    // A failing regression must still retire its known fixture child, without PID-reuse signalling.
    if (f.member) {
      const current = await identity(f.member.pid);
      if (active(current) && current.birth === f.member.birth)
        process.kill(f.member.pid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function announced(f) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(f.ready, "utf8"));
      const info = await identity(record.child);
      assert.ok(active(info));
      f.member = { pid: record.child, birth: info.birth };
      return { ...record, group: info.group };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await pause(10);
  }
  assert.fail("Owned stubborn descendant never announced readiness.");
}
async function invoke(f, timeout = 10000) {
  const oldPath = process.env.PATH;
  process.env.PATH = f.bin;
  try {
    await nativePreparationCommand(
      process.execPath,
      [join(f.tools, "build.mjs"), f.source, f.compiler, join(f.work, "build")],
      join(f.work, "build.log"),
      f.work,
      timeout,
    );
    assert.fail("The owned command with a stubborn descendant must reject.");
  } catch (error) {
    return error;
  } finally {
    process.env.PATH = oldPath;
  }
}
async function stopped(f, operation) {
  const error = await operation;
  assert.match(error.message, /Native asset preparation failed/);
  assert.equal(
    active(await identity(f.member.pid)),
    false,
    "preparation settled with an executable descendant",
  );
}
test(
  "outer deadline drains a stubborn grandchild after the actual tar leader exits",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const operation = invoke(f, 1500);
    await announced(f);
    await stopped(f, operation);
  },
);
test(
  "outer deadline allows inner KILL escalation when both actual leader and descendant ignore TERM",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { stubbornLeader: true });
    const operation = invoke(f, 1500);
    await announced(f);
    await stopped(f, operation);
  },
);
test(
  "actual SIGINT and SIGTERM cannot retire owned groups before stubborn descendants stop",
  { timeout: 20000 },
  async (t) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const f = await fixture(t);
      const before = process.listenerCount(signal);
      const operation = invoke(f);
      await announced(f);
      process.kill(process.pid, signal);
      await stopped(f, operation);
      assert.equal(process.listenerCount(signal), before);
    }
  },
);
test(
  "natural successful leader exit keeps the supervisor alive until orphan descendants drain",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { natural: true });
    const operation = invoke(f);
    const record = await announced(f);
    const deadline = performance.now() + 1000;
    while (
      active(await identity(record.leader)) &&
      performance.now() < deadline
    )
      await pause(10);
    assert.equal(active(await identity(record.leader)), false);
    assert.ok(
      active(await identity(record.group)),
      "the supervisor must anchor the PGID after command exit",
    );
    await stopped(f, operation);
    assert.match(
      await readFile(join(f.work, "build.log"), "utf8"),
      /"reason":"descendant"/,
    );
  },
);

test(
  "abrupt driver death reports uncertain nested drain before any scratch can be retired",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const operation = invoke(f);
    const record = await announced(f);
    const driver = (await identity(record.group)).parent;
    assert.ok(
      (await readFile(`/proc/${driver}/cmdline`, "utf8"))
        .split("\0")
        .includes(join(f.tools, "build.mjs")),
    );
    process.kill(driver, "SIGKILL");
    const error = await operation;
    assert.equal(error.code, "NATIVE_GROUP_DRAIN");
    assert.match(error.message, /uncertain.*scratch is retained/);
    const deadline = performance.now() + 4000;
    while (active(await identity(f.member.pid)) && performance.now() < deadline)
      await pause(20);
    assert.equal(
      active(await identity(f.member.pid)),
      false,
      "orphan supervisor fallback did not stop its descendant",
    );
  },
);
