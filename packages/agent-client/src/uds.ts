import { lstat, realpath } from "node:fs/promises";
import { request } from "node:http";
import { isAbsolute } from "node:path";

/** An exact local socket, owned by this user; the launch handle still authorizes. */
export async function exchangeOnSocket(
  socketPath: string,
  body: string,
): Promise<string> {
  if (!isAbsolute(socketPath) || socketPath.length > 256)
    throw new Error("agent socket path invalid");
  const stat = await lstat(socketPath);
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("agent socket must be current-user-only");
  }
  if ((await realpath(socketPath)) !== socketPath)
    throw new Error("agent socket path must be canonical");
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("agent launch exchange failed"));
    const req = request(
      {
        socketPath,
        path: "/v1/agent-capabilities/token",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        if (response.statusCode !== 200) {
          response.destroy();
          fail();
          return;
        }
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) {
            response.destroy();
            fail();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
        response.on("error", fail);
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      fail();
    }, 5000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", fail);
    req.end(body);
  });
}
