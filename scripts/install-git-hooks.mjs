import { spawnSync } from 'node:child_process';

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  windowsHide: true,
});

if (result.status !== 0) {
  const detail = String(result.stderr ?? '').trim();
  throw new Error(`Could not configure the repository hooks${detail ? `: ${detail}` : ''}`);
}

console.log('Installed repository Git hooks from .githooks/.');
