#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
if (
  process.env.PARITY_BAD_BATCH &&
  args[0] === "run" &&
  args.includes("--no-masking")
) {
  process.stdout.write("malformed-secret-canary");
  process.exit(0);
}
const path = process.env.PARITY_DB;
const log = process.env.PARITY_LOG;
const db = JSON.parse(fs.readFileSync(path, "utf8"));
fs.appendFileSync(
  log,
  `${JSON.stringify({
    args,
    token: process.env.OP_SERVICE_ACCOUNT_TOKEN,
    account: process.env.OP_ACCOUNT,
  })}\n`,
);
const vault = { id: "b".repeat(26), name: "Automation" };
const out = (value) => process.stdout.write(JSON.stringify(value));
const save = () => fs.writeFileSync(path, JSON.stringify(db));
const input = () => fs.readFileSync(0, "utf8");
if (
  process.env.PARITY_FAIL_READ &&
  db.written &&
  args[0] === "item" &&
  args[1] === "get"
) {
  process.stderr.write("private-failure-canary");
  process.exit(1);
}
if (process.env.PARITY_STUCK_VERSION && args[0] === "--version") {
  setInterval(() => {}, 1_000);
} else if (args[0] === "--version") process.stdout.write("2.32.0");
else if (args[0] === "account" && args[1] === "list") out([]);
else if (args[0] === "vault" && args[1] === "list")
  out(
    process.env.OP_SERVICE_ACCOUNT_TOKEN
      ? [vault]
      : [vault, { id: "c".repeat(26), name: "Personal" }],
  );
else if (args[0] === "service-account" && args[1] === "create")
  process.stdout.write("ops_fake-token");
else if (args[0] === "item" && args[1] === "list")
  out(
    db.items
      .filter(
        (i) =>
          !args.includes("--vault") ||
          i.vault.id === args[args.indexOf("--vault") + 1] ||
          i.vault.name === args[args.indexOf("--vault") + 1],
      )
      .map(({ fields, ...item }) => item),
  );
else if (args[0] === "item" && args[1] === "create") {
  const item = JSON.parse(input());
  item.id = "d".repeat(26);
  item.vault =
    args[args.indexOf("--vault") + 1] === "c".repeat(26)
      ? { id: "c".repeat(26), name: "Personal" }
      : vault;
  db.items.push(item);
  db.written = true;
  save();
  out(item);
} else if (args[0] === "item" && args[1] === "edit") {
  const item = JSON.parse(input());
  const idx = db.items.findIndex((i) => i.id === args[2]);
  db.items[idx] = item;
  db.written = true;
  save();
  out(item);
} else if (args[0] === "item" && args[1] === "get") {
  if (args[2] === "-") out(db.items);
  else {
    const item = db.items.find((i) => i.id === args[2] || i.title === args[2]);
    if (!item) process.exit(1);
    out(item);
  }
} else if (args[0] === "read") process.stdout.write("private-canary\n");
else if (args[0] === "run") {
  const separator = args.indexOf("--");
  const env = { ...process.env };
  for (const [key, value] of Object.entries(env))
    if (value.startsWith("op://")) env[key] = "private-canary\n";
  const fileArg = args.find((arg) => arg.startsWith("--env-file="));
  if (fileArg) {
    if (process.env.PARITY_MUTATE_ENV_FILE)
      fs.writeFileSync(
        process.env.PARITY_MUTATE_ENV_FILE,
        process.env.PARITY_ENV_REPLACEMENT ?? "",
      );
    const text = fs.readFileSync(fileArg.slice(11), "utf8");
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0)
        env[line.slice(0, eq)] = line.slice(eq + 1).startsWith("op://")
          ? "private-canary\n"
          : line.slice(eq + 1);
    }
  }
  const child = cp.spawnSync(args[separator + 1], args.slice(separator + 2), {
    env,
    stdio: "inherit",
  });
  process.exit(child.status ?? 1);
} else process.exit(1);
