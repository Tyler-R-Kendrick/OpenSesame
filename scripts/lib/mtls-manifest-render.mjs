/**
 * Markdown rendering for the mTLS evidence manifest (manifest.md and the
 * `summarize` table pasted into docs/validation/mtls-implementation.md).
 */

export function summarizeRows(steps) {
  const lines = [
    "| step | claim | scenarios | result | tests | exit | duration | reason / observed |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const s of steps) {
    const t = s.tests
      ? `${s.tests.passed}p/${s.tests.failed}f/${s.tests.ignored ?? 0}i`
      : "-";
    lines.push(
      `| \`${s.id}\` | ${s.claim_id} | ${s.scenario_ids.join(", ") || "-"} | **${s.result}** | ${t} | ${s.exit_code ?? "-"} | ${s.duration_ms} ms | ${(s.reason ?? s.observed ?? "").replace(/\|/g, "\\|")} |`,
    );
  }
  return lines.join("\n");
}

export function renderMarkdown(manifest) {
  const v = manifest.versions;
  const fx = Object.entries(v.fixtures ?? {})
    .map(([k, x]) => `${k} ${x.version}`)
    .join(", ");
  return [
    `# mTLS evidence manifest — ${manifest.suite}`,
    "",
    `- source_commit: \`${manifest.source_commit}\`${manifest.dirty ? " (dirty tree)" : ""}`,
    `- tested_tree: \`${manifest.tested_tree}\``,
    `- started: ${manifest.started_at}, finished: ${manifest.finished_at}`,
    `- toolchain: ${v.rustc} · ${v.cargo} · node ${v.node} · pnpm ${v.pnpm}`,
    `- rustls ${v.cargo_lock.rustls} · tokio-rustls ${v.cargo_lock["tokio-rustls"]} · async-nats ${v.cargo_lock["async-nats"]} · oidc-provider ${v.pnpm_lock["oidc-provider"]}`,
    `- fixtures: ${fx || "none pinned"}`,
    `- verdict: **${manifest.verdict}** (${manifest.counts.passed} passed, ${manifest.counts.failed} failed, ${manifest.counts.not_executed} not_executed, ${manifest.counts.unsupported} unsupported)`,
    "",
    summarizeRows(manifest.steps),
    "",
    "A local manifest is a statement about this checkout and these fixtures, not about any deployment.",
    "",
  ].join("\n");
}
