import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeLocks } from "../locks.js";
const [directory, output, operation] = process.argv.slice(2);
if (!directory || !output) throw new Error("Missing fixture paths.");
if (operation === "reader" || operation === "exclusive") {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `${createHash("sha256").update("process-proof").digest("hex")}.sqlite`,
  );
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS mutex_marker (id INTEGER PRIMARY KEY)");
    db.exec(operation === "exclusive" ? "BEGIN EXCLUSIVE" : "BEGIN");
    db.prepare("SELECT * FROM mutex_marker").all();
    process.stdout.write("ready\n");
    await new Promise<void>((resolve) =>
      process.stdin.once("data", () => resolve()),
    );
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
} else {
  await createNodeLocks(directory).request("process-proof", async () => {
    if (operation === "hold") {
      writeFileSync(`${output}.ready`, "held");
      await new Promise<void>((resolve) => setTimeout(resolve, 60000));
      return;
    }
    appendFileSync(output, "start\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    appendFileSync(output, "end\n");
  });
}
