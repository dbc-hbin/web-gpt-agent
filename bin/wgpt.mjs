#!/usr/bin/env node
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
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
const configured = env.WGPT_APP_EXECUTABLE?.trim() || '';

function usableExecutable(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function nodeOnPath() {
  const names = process.platform === 'win32' ? ['node.exe', 'nodejs.exe'] : ['node', 'nodejs'];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (usableExecutable(candidate)) return candidate;
    }
  }
  return '';
}

if (packaged) {
  entry ||= path.join(archive, 'out', 'cli', 'index.js');
  const appRoot = path.resolve(resources, '..');
  if (configured) {
    // An explicit override is used verbatim (PATH names included); spawn reports it if unusable.
    executable = configured;
  } else {
    const appName = env.WGPT_APP_NAME || 'Web GPT Agent';
    const executableName = env.WGPT_EXECUTABLE_NAME || 'web-gpt-agent';
    const macOS = path.join(appRoot, 'MacOS');
    const candidates = process.platform === 'darwin'
      ? [path.join(macOS, appName)]
      : process.platform === 'win32'
        ? [path.join(appRoot, appName + '.exe'), path.join(appRoot, executableName + '.exe')]
        : [path.join(appRoot, executableName), path.join(appRoot, appName)];
    if (process.platform === 'darwin' && existsSync(macOS)) {
      candidates.push(...readdirSync(macOS).map(name => path.join(macOS, name)));
    }
    executable = candidates.find(usableExecutable) || '';
  }
  if (!executable) {
    process.stderr.write(`wgpt: found ${archive} but no app executable to run it with\n`);
    process.exit(2);
  }
  env.WGPT_APP_EXECUTABLE = executable;
  env.ELECTRON_RUN_AS_NODE = '1';
  env.WGPT_DAEMON_ENTRY ||= path.join(resources, 'app.asar.unpacked', 'out', 'daemon', 'index.js');
} else {
  const repo = resources;
  entry ||= path.join(repo, 'out', 'cli', 'index.js');
  env.WGPT_REPO_ROOT ||= repo;
  env.WGPT_DAEMON_ENTRY ||= path.join(repo, 'out', 'daemon', 'index.js');
  const dist = path.join(repo, 'node_modules', 'electron', 'dist');
  // An explicit override is passed through verbatim; the CLI's own spawn reports it if unusable.
  env.WGPT_APP_EXECUTABLE = configured || [
    path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    path.join(dist, 'electron.exe'),
    path.join(dist, 'electron')
  ].find(usableExecutable) || '';
}

if (!existsSync(entry) && !packaged) {
  process.stderr.write(`wgpt: ${entry} is missing; run 'npm run build' first\n`);
  process.exit(2);
}
env.WGPT_CLI_ENTRY = entry;
env.WGPT_NODE_EXECUTABLE ||= process.versions.electron ? nodeOnPath() : process.execPath;

const child = spawnSync(executable, [entry, ...process.argv.slice(2)], { env, stdio: 'inherit' });
if (child.error) {
  process.stderr.write(`wgpt: ${child.error.message}\n`);
  process.exit(2);
}
if (child.signal) {
  process.kill(process.pid, child.signal);
}
process.exit(child.status ?? 1);
