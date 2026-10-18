/** Exercise the actual WXT dependency against a loopback ADB protocol peer. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import { test } from "node:test";

const extension = createRequire(
  new URL("../../apps/browser-extension/package.json", import.meta.url),
);
const wxt = createRequire(extension.resolve("wxt"));
const webExt = createRequire(wxt.resolve("web-ext-run"));
const adbRequire = createRequire(webExt.resolve("@devicefarmer/adbkit"));
const { Adb } = webExt("@devicefarmer/adbkit");
const asciiLength = (text) =>
  Buffer.byteLength(text).toString(16).padStart(4, "0") + text;
const uint = (value) => {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
};
const syncPacket = (id, payload) =>
  Buffer.concat([Buffer.from(id), uint(payload.length), payload]);

async function peer(run) {
  const commands = [];
  const uploads = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let sync = false;
    let destination;
    const send = (value, end = false) => {
      const bytes = Buffer.from(value);
      // Split the status and length fields over writes to exercise upstream parsing.
      socket.write(bytes.subarray(0, 2));
      setImmediate(() =>
        end ? socket.end(bytes.subarray(2)) : socket.write(bytes.subarray(2)),
      );
    };
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= (sync ? 8 : 4)) {
        const id = sync ? buffer.toString("ascii", 0, 4) : null;
        const length = sync
          ? buffer.readUInt32LE(4)
          : Number.parseInt(buffer.toString("ascii", 0, 4), 16);
        const header = sync ? 8 : 4;
        const payloadLength = id === "DONE" ? 0 : length;
        if (buffer.length < header + payloadLength) return;
        const payload = buffer.subarray(header, header + payloadLength);
        buffer = buffer.subarray(header + payloadLength);
        if (sync) {
          if (id === "LIST") {
            if (payload.toString() === "/denied")
              send(syncPacket("FAIL", Buffer.from("permission denied")));
            else
              send(
                Buffer.concat([
                  Buffer.from("DENT"),
                  uint(0o100644),
                  uint(7),
                  uint(123),
                  uint(8),
                  Buffer.from("test.xpi"),
                  Buffer.from("DONE"),
                  Buffer.alloc(16),
                ]),
              );
          } else if (id === "SEND") destination = payload.toString();
          else if (id === "DATA") uploads.push(Buffer.from(payload));
          else if (id === "DONE")
            send(
              syncPacket(
                destination.startsWith("/denied") ? "FAIL" : "OKAY",
                destination.startsWith("/denied")
                  ? Buffer.from("permission denied")
                  : Buffer.alloc(0),
              ),
            );
          continue;
        }
        const command = payload.toString();
        commands.push(command);
        if (command === "host:devices")
          send(
            `OKAY${asciiLength(
              "online\tdevice\noffline\toffline\nlocked\tunauthorized\n",
            )}`,
            true,
          );
        else if (command.startsWith("host:transport:")) send("OKAY");
        else if (command === "sync:") {
          sync = true;
          send("OKAY");
        } else if (command.startsWith("shell:am start"))
          send("OKAYError: Activity not found\n", true);
        else if (command.startsWith("shell:"))
          send("OKAYtransport works\n", true);
        else if (command.includes(":forward:"))
          send(`OKAYOKAY${asciiLength("43210")}`, true);
        else socket.destroy(new Error(`Unexpected command ${command}`));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(
      Adb.createClient({ host: "127.0.0.1", port: server.address().port }),
      commands,
      uploads,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("public WXT dependency loads without the excluded crypto dependency", () => {
  assert.throws(() => adbRequire.resolve("node-forge"), {
    code: "MODULE_NOT_FOUND",
  });
  assert.equal(typeof Adb.createClient, "function");
  assert.equal(Adb.createClient().bin, "adb");
  const client = Adb.createClient({
    host: "127.0.0.2",
    port: 12345,
    bin: "/configured/adb",
    timeout: 21,
  });
  assert.deepEqual(client.options, {
    host: "127.0.0.2",
    port: 12345,
    bin: "/configured/adb",
    timeout: 21,
  });
  assert.throws(() => Adb.util.parsePublicKey("unused"), /node-forge/);
  assert.throws(() => client.createTcpUsbBridge("unused"), /node-forge/);
});

test(
  "fragmented host replies preserve all device states and shell readAll",
  { timeout: 5000 },
  async () => {
    await peer(async (client, commands) => {
      assert.deepEqual(await client.listDevices(), [
        { id: "online", type: "device" },
        { id: "offline", type: "offline" },
        { id: "locked", type: "unauthorized" },
      ]);
      assert.equal(
        (
          await Adb.util.readAll(
            await client.getDevice("online").shell("echo transport"),
          )
        ).toString(),
        "transport works\n",
      );
      assert.ok(commands.includes("host:transport:online"));
      assert.ok(commands.includes("shell:echo transport"));
    });
  },
);

test(
  "file listing and push retain sync completion and permission errors",
  { timeout: 5000 },
  async () => {
    await peer(async (client, commands, uploads) => {
      const device = client.getDevice("online");
      const entries = await device.readdir("/extensions");
      assert.equal(entries[0].name, "test.xpi");
      assert.equal(entries[0].size, 7);
      await assert.rejects(device.readdir("/denied"), /permission denied/);
      const push = await device.push(
        Readable.from([Buffer.from("payload")]),
        "/extensions/test.xpi",
      );
      await once(push, "end");
      assert.equal(Buffer.concat(uploads).toString(), "payload");
      const denied = await device.push(
        Readable.from([Buffer.from("payload")]),
        "/denied/test.xpi",
      );
      await assert.rejects(once(denied, "end"), /permission denied/);
    });
  },
);

test(
  "activity failures remain observable for fallback and forward requests roundtrip",
  { timeout: 5000 },
  async () => {
    await peer(async (client, commands) => {
      const device = client.getDevice("online");
      await assert.rejects(
        device.startActivity({ component: "org.mozilla.firefox/.App" }),
        /Activity not found/,
      );
      assert.equal(
        (
          await Adb.util.readAll(
            await device.shell("monkey -p org.mozilla.firefox 1"),
          )
        ).toString(),
        "transport works\n",
      );
      await device.forward(
        "tcp:43210",
        "localabstract:firefox-debugger-socket",
      );
      assert.ok(
        commands.some((value) =>
          value.includes(
            ":forward:tcp:43210;localabstract:firefox-debugger-socket",
          ),
        ),
      );
    });
  },
);

test(
  "connection refusal invokes the configured adb binary with its port",
  { timeout: 5000 },
  async () => {
    const { mkdtemp, writeFile, readFile, rm } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "os-adb-configured-bin-"));
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    try {
      const bin = join(directory, "adb");
      const record = join(directory, "args");
      await writeFile(
        bin,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2))); process.exit(1);\n`,
        { mode: 0o755 },
      );
      await assert.rejects(
        Adb.createClient({ host: "127.0.0.1", port, bin }).listDevices(),
      );
      assert.deepEqual(JSON.parse(await readFile(record, "utf8")), [
        "-P",
        String(port),
        "start-server",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
