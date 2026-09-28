#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const resources = path.resolve(scriptDir, '..');
const archive = path.join(resources, 'app.asar');
const packaged = existsSync(archive);
const env = { ...process.env };
let executable = process.execPath;
let entry = env.WGPT_CLI_ENTRY?.trim() || '';

if (packaged) {
  entry ||= path.join(archive, 'out', 'cli', 'index.js');
  const appRoot = path.resolve(resources, '..');
  const configured = env.WGPT_APP_EXECUTABLE?.trim();
  const candidates = configured
    ? [configured]
    : process.platform === 'win32'
      ? [
          path.join(appRoot, `${env.WGPT_APP_NAME || 'Web GPT Agent'}.exe`),
          path.join(appRoot, `${env.WGPT_EXECUTABLE_NAME || 'web-gpt-agent'}.exe`)
        ]
      : [];
  executable = candidates.find(candidate => existsSync(candidate)) || '';
  if (!executable) {
    process.stderr.write(`wgpt: found ${archive} but no app executable to run it with\n`);
    process.exit(2);
  }
  env.ELECTRON_RUN_AS_NODE = '1';
  env.WGPT_DAEMON_ENTRY ||= path.join(resources, 'app.asar.unpacked', 'out', 'daemon', 'index.js');
} else {
  const repo = resources;
  entry ||= path.join(repo, 'out', 'cli', 'index.js');
  env.WGPT_REPO_ROOT ||= repo;
  env.WGPT_DAEMON_ENTRY ||= path.join(repo, 'out', 'daemon', 'index.js');
}

if (!existsSync(entry) && !packaged) {
  process.stderr.write(`wgpt: ${entry} is missing; run 'npm run build' first\n`);
  process.exit(2);
}
env.WGPT_CLI_ENTRY = entry;
env.WGPT_NODE_EXECUTABLE ||= process.execPath;

const child = spawnSync(executable, [entry, ...process.argv.slice(2)], { env, stdio: 'inherit' });
if (child.error) {
  process.stderr.write(`wgpt: ${child.error.message}\n`);
  process.exit(2);
}
if (child.signal) {
  process.kill(process.pid, child.signal);
}
process.exit(child.status ?? 1);
