import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') {
  throw new Error(`smoke-macos-gui.mjs must run on macOS, got ${process.platform}`);
}

const arch = process.argv[2];
if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Expected x64 or arm64, got ${arch ?? '(missing)'}`);
const unpackedDir = arch === 'arm64' ? 'mac-arm64' : 'mac';
const executable = path.resolve(
  'release',
  unpackedDir,
  'Web GPT Agent.app',
  'Contents',
  'MacOS',
  'Web GPT Agent'
);
if (!existsSync(executable)) throw new Error(`Could not find unpacked macOS ${arch} app executable`);

// Like the Linux package smokes, launch against a throwaway profile. A resident desktop
// backend on the host would otherwise take the launch, and this smoke must prove a cold start.
const smokeRoot = mkdtempSync(path.join(tmpdir(), 'wga-mac-gui-'));
const dataDir = path.join(smokeRoot, 'data');
const child = spawn(executable, ['--data-dir', dataDir], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLF_DEBUG: '1' }
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

let exitResult;
const exitPromise = new Promise((resolve) => {
  child.once('exit', (code, signal) => {
    exitResult = { code, signal };
    resolve(exitResult);
  });
});

const startedAt = Date.now();
const startupDeadlineMs = 15_000;
const minimumSurvivalMs = 10_000;

let startupError = null;
try {
  await new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    clearTimeout(deadline);
    child.off('error', onError);
    child.off('exit', onExit);
    error ? reject(error) : resolve();
  };
  const onError = (error) => finish(error);
  const onExit = (code, signal) =>
    finish(new Error(`macOS GUI exited before startup proof completed: code=${code} signal=${signal}`));
  const startupFailure = () => {
    if (output.includes('[error] window failed to load')) return 'the BrowserWindow reported a load failure';
    if (output.includes('[error] renderer:')) return 'the renderer reported a console error';
    return null;
  };
  const ready = () =>
    output.includes('[info] app started') &&
    output.includes('[info] window loaded') &&
    output.includes('[info] renderer state ready') &&
    Date.now() - startedAt >= minimumSurvivalMs;

  child.on('error', onError);
  child.on('exit', onExit);
  const poll = setInterval(() => {
    const failure = startupFailure();
    if (failure) finish(new Error(`macOS GUI startup failed: ${failure}`));
    else if (ready()) finish();
  }, 50);
  const deadline = setTimeout(() => {
    const failure = startupFailure();
    if (failure) finish(new Error(`macOS GUI startup failed: ${failure}`));
    else if (ready()) finish();
    else finish(new Error('macOS GUI did not report app started, window loaded and renderer state ready within 15 seconds'));
  }, startupDeadlineMs);
  });
} catch (error) {
  startupError = error;
}

async function terminateChild() {
  if (exitResult) return true;
  child.kill('SIGTERM');
  let exited = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000))
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3_000))
    ]);
  }
  return exited;
}

// The GUI starts a detached desktop backend for this throwaway profile. Stop that exact owner
// (named by its runtime descriptor) so no Electron process outlives the smoke.
async function terminateBackend() {
  let pid = null;
  try { pid = JSON.parse(readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).pid; } catch { return true; }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!alive()) return true;
    try { process.kill(pid, signal); } catch { return !alive(); }
    for (let waited = 0; waited < 5_000 && alive(); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive();
}

// Whether startup passed or failed, never leave an Electron child behind on the hosted runner.
// This tests launch readiness, not the application's own quit flow.
const exited = await terminateChild();
const backendExited = await terminateBackend();
rmSync(smokeRoot, { recursive: true, force: true });
process.stdout.write(output);
if (startupError) {
  if (!exited) startupError.message += '; child also resisted SIGTERM/SIGKILL';
  if (!backendExited) startupError.message += '; its backend also resisted SIGTERM/SIGKILL';
  throw startupError;
}
if (!exited) throw new Error('macOS GUI process did not terminate after SIGTERM/SIGKILL');
if (!backendExited) throw new Error('macOS desktop backend did not terminate after SIGTERM/SIGKILL');
process.stdout.write(
  `macos-gui-startup-ok arch=${arch} exit=${exitResult?.code ?? 'null'} signal=${exitResult?.signal ?? 'null'}\n`
);
