import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  candidateSourceDigest,
  candidateTree,
  checkCodeqlArtifacts,
  sourceDigestEntries,
} from "./check-codeql-artifacts.mjs";

const sha = "a".repeat(40);
const sourceDigest = "b".repeat(64);
const languageFiles = {
  actions: "actions.sarif",
  "javascript-typescript": "javascript.sarif",
  python: "python.sarif",
  rust: "rust.sarif",
  go: "go.sarif",
  "go-native-wasm": "go.sarif",
  "go-native-host": "go.sarif",
  "java-kotlin": "java.sarif",
};
const clean = {
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "CodeQL" } },
      results: [],
      invocations: [{ executionSuccessful: true }],
    },
  ],
};

function cleanFor(language) {
  const report = structuredClone(clean);
  report.runs[0].automationDetails = { id: `/language:${language}/` };
  return report;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "codeql-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [language, file] of Object.entries(languageFiles)) {
    const folder = join(directory, `codeql-sarif-${language}-${sha}`);
    mkdirSync(folder);
    writeFileSync(join(folder, file), JSON.stringify(cleanFor(language)));
  }
  return {
    directory,
    file: (language) =>
      join(
        directory,
        `codeql-sarif-${language}-${sha}`,
        languageFiles[language],
      ),
    folder: (language) => join(directory, `codeql-sarif-${language}-${sha}`),
  };
}

test("accepts exactly eight complete clean source-bound analyses", (t) => {
  const f = fixture(t);
  assert.equal(checkCodeqlArtifacts(f.directory, sha, sourceDigest), 8);
  assert.throws(() => checkCodeqlArtifacts(f.directory, sha), /source digest/);
});

test("passes the candidate digest to reviewed finding checks", (t) => {
  const f = fixture(t);
  const report = cleanFor("javascript-typescript");
  report.runs[0].results = JSON.parse(
    readFileSync(
      new URL("./fixtures/codeql-reviewed-660.json", import.meta.url),
      "utf8",
    ),
  );
  writeFileSync(f.file("javascript-typescript"), JSON.stringify(report));
  assert.equal(
    checkCodeqlArtifacts(
      f.directory,
      sha,
      "6acbd6141bf5e99ce292e76c909acabbb14fd1e654c51f24d899e7987891240e",
    ),
    8,
  );
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /unreviewed finding/,
  );
});

test("rejects missing and unexpected language artifacts", (t) => {
  const f = fixture(t);
  rmSync(f.folder("go"), { recursive: true });
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /artifact set/,
  );
  mkdirSync(join(f.directory, `codeql-sarif-unknown-${sha}`));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /artifact set/,
  );
});

test("requires both native Go analyses and refuses their findings or extraction errors", (t) => {
  for (const language of ["go-native-wasm", "go-native-host"]) {
    const f = fixture(t);
    rmSync(f.folder(language), { recursive: true });
    assert.throws(
      () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
      /artifact set/,
    );
  }
  const f = fixture(t);
  const finding = cleanFor("go-native-wasm");
  finding.runs[0].results.push({ ruleId: "go/example" });
  writeFileSync(f.file("go-native-wasm"), JSON.stringify(finding));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /unreviewed finding/,
  );
  writeFileSync(
    f.file("go-native-wasm"),
    JSON.stringify(cleanFor("go-native-wasm")),
  );
  const error = cleanFor("go-native-host");
  error.runs[0].invocations[0].toolExecutionNotifications = [
    { level: "error" },
  ];
  writeFileSync(f.file("go-native-host"), JSON.stringify(error));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /execution or configuration error/,
  );
});

test("rejects an incorrect source SHA or artifact for a different source", (t) => {
  const f = fixture(t);
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, "not-a-sha", sourceDigest),
    /source SHA/,
  );
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, "b".repeat(40), sourceDigest),
    /artifact set/,
  );
});

test("rejects missing, extra, renamed or linked SARIF files", (t) => {
  const f = fixture(t);
  rmSync(f.file("go"));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /SARIF files/,
  );
  const renamed = join(f.folder("go"), "renamed.sarif");
  writeFileSync(renamed, JSON.stringify(clean));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /SARIF files/,
  );
  rmSync(renamed);
  writeFileSync(f.file("go"), JSON.stringify(clean));
  writeFileSync(join(f.folder("go"), "extra.sarif"), JSON.stringify(clean));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /SARIF files/,
  );
  rmSync(join(f.folder("go"), "extra.sarif"));
  rmSync(f.file("go"));
  symlinkSync(f.file("python"), f.file("go"));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /SARIF files/,
  );
});

test("rejects a copied or missing language category", (t) => {
  const f = fixture(t);
  const wrong = cleanFor("rust");
  writeFileSync(f.file("go"), JSON.stringify(wrong));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /language category/,
  );
  Reflect.deleteProperty(wrong.runs[0], "automationDetails");
  writeFileSync(f.file("go"), JSON.stringify(wrong));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /language category/,
  );
});

test("rejects malformed SARIF and unsuccessful analysis", (t) => {
  const f = fixture(t);
  writeFileSync(f.file("python"), "not JSON");
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    SyntaxError,
  );
  writeFileSync(
    f.file("python"),
    JSON.stringify({ version: "2.1.0", runs: [] }),
  );
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /invalid CodeQL SARIF/,
  );
  const bad = structuredClone(clean);
  bad.runs[0].invocations[0].executionSuccessful = false;
  writeFileSync(f.file("python"), JSON.stringify(bad));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /did not succeed/,
  );
});

test("rejects any finding or extractor error in every language", (t) => {
  const f = fixture(t);
  const bad = structuredClone(clean);
  bad.runs[0].results.push({ ruleId: "a-finding" });
  writeFileSync(f.file("javascript-typescript"), JSON.stringify(bad));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /unreviewed finding/,
  );
  writeFileSync(
    f.file("javascript-typescript"),
    JSON.stringify(cleanFor("javascript-typescript")),
  );
  bad.runs[0].results = [];
  bad.runs[0].invocations[0].toolExecutionNotifications = [{ level: "error" }];
  writeFileSync(f.file("go"), JSON.stringify(bad));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /execution or configuration error/,
  );
  bad.runs[0].invocations[0].toolExecutionNotifications = [];
  bad.runs[0].invocations[0].toolConfigurationNotifications = [
    { level: "error" },
  ];
  writeFileSync(f.file("go"), JSON.stringify(bad));
  assert.throws(
    () => checkCodeqlArtifacts(f.directory, sha, sourceDigest),
    /execution or configuration error/,
  );
});

test("does not use a candidate-controlled gate in the current directory", (t) => {
  const f = fixture(t);
  const candidate = join(f.directory, "candidate");
  mkdirSync(candidate);
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  mkdirSync(join(candidate, "scripts", "release"), { recursive: true });
  writeFileSync(
    join(candidate, "scripts", "release", "check-codeql-sarif.mjs"),
    "process.exit(0);\n",
  );
  const git = (...args) =>
    execFileSync("git", ["-C", candidate, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("add", "scripts/release/check-codeql-sarif.mjs");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
    "--no-gpg-sign",
  );
  const candidateSha = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  assert.equal(candidateTree(candidate, candidateSha), tree);
  assert.throws(() => candidateTree(candidate, sha), /does not match/);
  assert.throws(() => candidateTree(candidate, "HEAD"), /source SHA/);
  const bad = structuredClone(clean);
  bad.runs[0].results.push({ ruleId: "a-finding" });
  writeFileSync(f.file("rust"), JSON.stringify(bad));
  // Keep the candidate checkout separate from the artifact root just as CI does.
  const evidence = join(f.directory, "evidence");
  mkdirSync(evidence);
  for (const [language] of Object.entries(languageFiles)) {
    const source = f.folder(language);
    const destination = join(
      evidence,
      `codeql-sarif-${language}-${candidateSha}`,
    );
    mkdirSync(destination);
    const file = languageFiles[language];
    copyFileSync(join(source, file), join(destination, file));
  }
  const trusted = resolve(
    fileURLToPath(new URL("./check-codeql-artifacts.mjs", import.meta.url)),
  );
  const result = spawnSync(
    process.execPath,
    [trusted, evidence, candidateSha, candidate],
    {
      cwd: candidate,
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreviewed finding/);
});

test("source digest covers all entries except the controller review record", () => {
  const entry = (mode, oid, path) => `${mode} blob ${oid}\t${path}\0`;
  const oid = "a".repeat(40);
  const reviewed = entry(
    "100644",
    oid,
    "scripts/release/codeql-reviewed-inputs.json",
  );
  const product = entry("100644", oid, "application.js");
  const digest = sourceDigestEntries(Buffer.from(product + reviewed));
  assert.equal(
    sourceDigestEntries(
      Buffer.from(
        product +
          entry(
            "100644",
            "b".repeat(40),
            "scripts/release/codeql-reviewed-inputs.json",
          ),
      ),
    ),
    digest,
  );
  assert.notEqual(
    sourceDigestEntries(
      Buffer.from(entry("100644", "b".repeat(40), "application.js") + reviewed),
    ),
    digest,
  );
  assert.notEqual(
    sourceDigestEntries(
      Buffer.from(entry("100755", oid, "application.js") + reviewed),
    ),
    digest,
  );
  assert.notEqual(
    sourceDigestEntries(
      Buffer.from(
        product +
          reviewed +
          entry(
            "100644",
            oid,
            "scripts/release/codeql-reviewed-inputs.json.other",
          ),
      ),
    ),
    digest,
  );
  assert.throws(
    () => sourceDigestEntries(Buffer.from("malformed")),
    /Malformed/,
  );
  assert.throws(
    () => candidateSourceDigest(".", "HEAD"),
    /Invalid candidate tree/,
  );
});
