import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('failed catalogue install is degraded and concurrent user edits survive', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skills-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  mkdirSync(join(root, 'scripts/dev'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../dev/install-agent-skills.sh', import.meta.url)), join(root, 'scripts/dev/install-agent-skills.sh'));
  put('scripts/dev/sync-agent-skills.mjs', '');
  put('skills-lock.json', JSON.stringify({ skills: { demo: { source: 'example/demo' } } }));
  put('.codex/hooks.json', '{"original":true}\n');
  put('.claude/settings.json', '{}\n');
  put('.claude/settings.local.json', '{"hooks":{"PreToolUse":[{"command":"impeccable personal"}]}}\n');
  put('.grok/hooks/impeccable.json', '{"personal":"impeccable"}\n');
  put('.gitignore', '.claude/settings.local.json\n.grok/\n.agents/\nbin/\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  put('bin/npx', '#!/bin/sh\nif [ "$2" = skills@1.7.4 ] && [ "$3" = add ]; then\n  printf "{\\"userEdit\\":true}\\n" > .codex/hooks.json\n  exit 1\nfi\nexit 0\n');
  chmodSync(join(root, 'bin/npx'), 0o755);
  execFileSync('bash', ['scripts/dev/install-agent-skills.sh'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH }, stdio: 'pipe' });
  assert.equal(readFileSync(join(root, '.codex/hooks.json'), 'utf8'), '{"userEdit":true}\n');
  assert.equal(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'), '{"hooks":{"PreToolUse":[{"command":"impeccable personal"}]}}\n');
  assert.equal(readFileSync(join(root, '.grok/hooks/impeccable.json'), 'utf8'), '{"personal":"impeccable"}\n');
  assert.equal(JSON.parse(readFileSync(join(root, '.agents/.skills-currency.json'), 'utf8')).status, 'degraded');

  // An installer-created hook is left for inspection, but must make an
  // otherwise successful run visibly degraded before an agent is started.
  put('.codex/hooks.json', '{\"original\":true}\n');
  put('bin/npx', '#!/bin/sh\nmkdir -p .github/hooks\nprintf \"{}\\n\" > .github/hooks/impeccable.json\nexit 0\n');
  chmodSync(join(root, 'bin/npx'), 0o755);
  const output = execFileSync('bash', ['scripts/dev/install-agent-skills.sh'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(readFileSync(join(root, '.agents/.skills-currency.json'), 'utf8')).status, 'degraded');
  assert.match(output, /status: degraded/u);
});
