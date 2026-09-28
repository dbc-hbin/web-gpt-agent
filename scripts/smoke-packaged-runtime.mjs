import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CUA_DRIVER, RIPGREP, TUNNEL_CLIENT } from './packaging-versions.mjs';
import { normalizeArch, normalizePlatform, PLATFORM_INFO } from './packaging-targets.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(repository, 'release');

function argValue(name, fallback) {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const targetPlatform = normalizePlatform(argValue('platform', process.platform));
const targetArch = normalizeArch(argValue('arch', process.arch));

function packageRootCandidates() {
  if (targetPlatform === 'win32') {
    return targetArch === 'x64'
      ? [path.join(releaseDir, 'win-unpacked'), path.join(releaseDir, 'win-x64-unpacked')]
      : [path.join(releaseDir, 'win-arm64-unpacked')];
  }
  if (targetPlatform === 'darwin') {
    return targetArch === 'x64' ? [path.join(releaseDir, 'mac'), path.join(releaseDir, 'mac-x64')] : [path.join(releaseDir, 'mac-arm64')];
  }
  return targetArch === 'x64'
    ? [path.join(releaseDir, 'linux-unpacked'), path.join(releaseDir, 'linux-x64-unpacked')]
    : [path.join(releaseDir, 'linux-arm64-unpacked')];
}

const explicitRoot = argValue('root', null);
const packageRoot = explicitRoot ? path.resolve(explicitRoot) : packageRootCandidates().find((candidate) => existsSync(candidate));
if (!packageRoot) throw new Error(`Could not find unpacked ${targetPlatform}-${targetArch} package under ${releaseDir}`);

const sourcePackage = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'));
const expectedVersion = sourcePackage.version;
const expectedElectronVersion = sourcePackage.devDependencies?.electron;
if (!/^\d+\.\d+\.\d+$/.test(expectedElectronVersion ?? '')) {
  throw new Error(`Electron must be pinned to an exact release version, got ${JSON.stringify(expectedElectronVersion)}`);
}
const suffix = PLATFORM_INFO[targetPlatform].executableSuffix;
const tunnelTarget = TUNNEL_CLIENT.targets[targetPlatform][targetArch];
const upstreamOs = PLATFORM_INFO[targetPlatform].upstreamOs;
const tunnelLicenseStem = `tunnel-client-${TUNNEL_CLIENT.version}-${upstreamOs}-${tunnelTarget.upstreamArch}`;
const nativeDir = `${targetPlatform}-${targetArch}`;
const cuaSupported = targetPlatform !== 'linux';
const cuaNative = `cua-driver-${targetPlatform}-${targetArch}${targetPlatform === 'win32' ? '-msvc' : targetPlatform === 'linux' ? '-gnu' : ''}`;

let resourcesDir;
let appExecutable;
if (targetPlatform === 'darwin') {
  const appBundle = path.join(packageRoot, 'Web GPT Agent.app');
  resourcesDir = path.join(appBundle, 'Contents', 'Resources');
  appExecutable = path.join(appBundle, 'Contents', 'MacOS', 'Web GPT Agent');
} else {
  resourcesDir = path.join(packageRoot, 'resources');
  appExecutable = path.join(packageRoot, targetPlatform === 'win32' ? 'Web GPT Agent.exe' : 'web-gpt-agent');
}

function required(relative) {
  const target = path.join(resourcesDir, ...relative.split('/'));
  if (!statSync(target).isFile()) throw new Error(`Packaged runtime is missing ${relative}`);
  return target;
}

for (const relative of [
  'app.asar',
  'app.asar.unpacked/out/daemon/index.js',
  'LICENSE',
  'THIRD-PARTY-NOTICES.txt',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  'extension/manifest.json',
  'extension/background.js',
  'extension/chatgpt-dom.js',
  'extension/content.js',
  'extension/fiber.js',
  'extension/overlay.css',
  'extension/popup.html',
  'extension/popup.css',
  'extension/popup.js',
  'extension/icons/icon16.png',
  'extension/icons/icon32.png',
  'extension/icons/icon48.png',
  'extension/icons/icon128.png',
  `tunnel/tunnel-client${suffix}`,
  `tunnel/cloudflared${suffix}`,
  'tunnel/VERSION',
  'tunnel/LICENSE',
  'tunnel/NOTICE',
  `tunnel/${tunnelLicenseStem}-licenses.txt`,
  `tunnel/${tunnelLicenseStem}.spdx.json`,
  `rg/rg${suffix}`,
  ...(cuaSupported ? [
    `desktop/cua-driver${suffix}`,
    'desktop/LICENSE.cua-driver.txt',
    'desktop/SOURCE.cua-driver.json',
    'app.asar.unpacked/node_modules/@trycua/cua-driver/dist/index.js',
    'app.asar.unpacked/node_modules/@trycua/cua-driver/dist/embedded.js',
    'app.asar.unpacked/node_modules/@ubjs/node/typescript/dist/resolve-lib.js',
    'app.asar.unpacked/node_modules/@ubjs/core/dist/esm/index.js',
    `app.asar.unpacked/node_modules/@trycua/${cuaNative}/cua_driver_node_runtime.node`,
    `app.asar.unpacked/node_modules/@trycua/${cuaNative}/${targetPlatform === 'win32' ? 'cua_driver_sdk.dll' : 'libcua_driver_sdk.dylib'}`,
    `app.asar.unpacked/node_modules/@trycua/${cuaNative}/node-runtime-NOTICE.md`
  ] : []),
  'rg/VERSION',
  'rg/COPYING',
  'rg/LICENSE-MIT',
  'rg/UNLICENSE',
  'app.asar.unpacked/node_modules/sharp/LICENSE',
  'app.asar.unpacked/node_modules/node-pty/LICENSE',
  'app.asar.unpacked/node_modules/tree-sitter/LICENSE',
  'app.asar.unpacked/node_modules/tree-sitter-bash/LICENSE',
  `app.asar.unpacked/node_modules/tree-sitter/prebuilds/${nativeDir}/tree-sitter.node`,
  `app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/${nativeDir}/tree-sitter-bash.node`
]) required(relative);

if (cuaSupported) {
  const cuaSource = JSON.parse(readFileSync(required('desktop/SOURCE.cua-driver.json'), 'utf8'));
  const cuaTarget = CUA_DRIVER.targets[targetPlatform][targetArch];
  if (cuaSource.version !== CUA_DRIVER.version || cuaSource.commit !== CUA_DRIVER.sourceCommit ||
      cuaSource.binarySha256 !== cuaTarget.sha256 || cuaSource.sourceSha256 !== CUA_DRIVER.sourceSha256 ||
      (cuaTarget.executableSha256 && cuaSource.executableSha256 !== cuaTarget.executableSha256) ||
      (targetPlatform !== 'darwin' && cuaSource.executableSha256 !== createHash('sha256').update(readFileSync(required(`desktop/cua-driver${suffix}`))).digest('hex'))) {
    throw new Error('Packaged Cua Driver does not match its pinned source and binary release');
  }
  if (createHash('sha256').update(readFileSync(required('desktop/LICENSE.cua-driver.txt'))).digest('hex') !== CUA_DRIVER.licenseSha256) {
    throw new Error('Packaged Cua Driver MIT license differs from pinned source');
  }
}

if (targetPlatform === 'win32') {
  required(`THIRD-PARTY-NOTICES-sharp-win32-${targetArch}.md`);
  required(`app.asar.unpacked/node_modules/@img/sharp-win32-${targetArch}/LICENSE`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/conpty.node`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/conpty_console_list.node`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/conpty/OpenConsole.exe`);
} else {
  required(`THIRD-PARTY-NOTICES-sharp-libvips-${targetPlatform}-${targetArch}.md`);
  required(`app.asar.unpacked/node_modules/@img/sharp-${targetPlatform}-${targetArch}/LICENSE`);
  // The pinned sharp-libvips 1.3.2 npm packages declare LGPL-3.0-or-later in package.json
  // but do not ship a LICENSE file. Require the metadata + version manifest they actually
  // publish instead of making every macOS/Linux smoke test fail on an invented file.
  required(`app.asar.unpacked/node_modules/@img/sharp-libvips-${targetPlatform}-${targetArch}/package.json`);
  required(`app.asar.unpacked/node_modules/@img/sharp-libvips-${targetPlatform}-${targetArch}/versions.json`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/pty.node`);
  if (targetPlatform === 'darwin') required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/spawn-helper`);
}

const extensionManifest = JSON.parse(readFileSync(path.join(resourcesDir, 'extension', 'manifest.json'), 'utf8'));
if (extensionManifest.version !== expectedVersion) {
  throw new Error(`Packaged extension ${extensionManifest.version} does not match app ${expectedVersion}`);
}
const tunnelVersion = readFileSync(path.join(resourcesDir, 'tunnel', 'VERSION'), 'utf8').trim();
const rgVersion = readFileSync(path.join(resourcesDir, 'rg', 'VERSION'), 'utf8').trim();
if (tunnelVersion !== TUNNEL_CLIENT.version) throw new Error(`Packaged tunnel-client ${tunnelVersion} != ${TUNNEL_CLIENT.version}`);
if (rgVersion !== RIPGREP.version) throw new Error(`Packaged ripgrep ${rgVersion} != ${RIPGREP.version}`);

for (const packageName of readdirSync(path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img')).filter((name) => name.startsWith('sharp-'))) {
  const expected = targetPlatform === 'win32'
    ? new Set([`sharp-win32-${targetArch}`])
    : new Set([`sharp-${targetPlatform}-${targetArch}`, `sharp-libvips-${targetPlatform}-${targetArch}`]);
  if (!expected.has(packageName)) throw new Error(`Packaged wrong-target Sharp payload ${packageName}`);
}

const cuaPackageDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@trycua');
const shippedCuaNative = existsSync(cuaPackageDir) ? readdirSync(cuaPackageDir).filter((name) => name.startsWith('cua-driver-')) : [];
if (cuaSupported ? (shippedCuaNative.length !== 1 || shippedCuaNative[0] !== cuaNative) : shippedCuaNative.length !== 0) {
  throw new Error(`Packaged wrong-target Cua Driver native payload: ${shippedCuaNative.join(', ')}`);
}

for (const dependency of ['node-pty', 'tree-sitter', 'tree-sitter-bash']) {
  const prebuilds = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', dependency, 'prebuilds');
  const directories = readdirSync(prebuilds, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (directories.length !== 1 || directories[0] !== nativeDir) {
    throw new Error(`Packaged ${dependency} prebuilds are ${directories.join(',') || '(none)'}, expected only ${nativeDir}`);
  }
}

for (const forbidden of [
  'desktop/macos-desktop-addon.node',
  'desktop/libcos-desktop.dylib',
  'desktop/macos-desktop-helper',
  'desktop/CuaDriver.app',
  'app.asar.unpacked/node_modules/node-pty/build/Release',
  'app.asar.unpacked/node_modules/node-pty/build/Debug',
  'app.asar.unpacked/node_modules/node-pty/third_party/conpty'
]) {
  if (existsSync(path.join(resourcesDir, ...forbidden.split('/')))) {
    throw new Error(`Obsolete or wrong-target native payload leaked into package: ${forbidden}`);
  }
}

function runExecutable(executable, args, expectedText, input) {
  const result = spawnSync(executable, args, { cwd: packageRoot, encoding: 'utf8', timeout: 15_000, input });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited ${result.status}: ${result.stderr || result.stdout}`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectedText && !output.includes(expectedText)) throw new Error(`${executable} output did not contain ${expectedText}: ${output}`);
}

if (process.platform !== targetPlatform || process.arch !== targetArch) {
  process.stdout.write(`Packaged ${targetPlatform}-${targetArch} resources verified for ${expectedVersion}; native execution skipped on ${process.platform}-${process.arch}.\n`);
  process.exit(0);
}

runExecutable(path.join(resourcesDir, 'rg', `rg${suffix}`), ['--version'], RIPGREP.version);
if (cuaSupported) runExecutable(path.join(resourcesDir, 'desktop', `cua-driver${suffix}`), ['--version'], CUA_DRIVER.version);
runExecutable(path.join(resourcesDir, 'tunnel', `tunnel-client${suffix}`), ['--version'], TUNNEL_CLIENT.version.replace(/^v/, ''));
runExecutable(path.join(resourcesDir, 'tunnel', `cloudflared${suffix}`), ['--version']);
const probe = String.raw`
(async () => {
  const base = process.env.COS_RESOURCES_DIR;
  const sharp = require(base + '/app.asar/node_modules/sharp');
  const pty = require(base + '/app.asar/node_modules/node-pty');
  const Parser = require(base + '/app.asar/node_modules/tree-sitter');
  const Bash = require(base + '/app.asar/node_modules/tree-sitter-bash');
  const manifest = require(base + '/app.asar/package.json');
  let cua = null;
  if (process.platform !== 'linux') {
    const { pathToFileURL } = require('node:url');
    const sdk = await import(pathToFileURL(base + '/app.asar.unpacked/node_modules/@trycua/cua-driver/dist/index.js').href);
    // Import the permission entry from the physical unpacked SDK, but never request access.
    const permission = await import(pathToFileURL(base + '/app.asar.unpacked/node_modules/@trycua/cua-driver/dist/electron.js').href);
    if (typeof permission.requestMacOSPermissions !== 'function') throw new Error('Cua permission SDK did not load');
    const embedded = new sdk.EmbeddedCuaDriverHost(base + '/desktop/' + (process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'), 'com.webgptagent.app');
    try { if (embedded.state() !== 0) throw new Error('Cua Driver host did not initialize stopped'); }
    finally { embedded.uniffiDestroy(); }
    cua = require(base + '/app.asar/node_modules/@trycua/cua-driver/package.json').version;
  }
  const fs = require('node:fs');
  for (const entry of ['index.js', 'daemon-client.js', 'desktop-backend.js']) {
    if (!fs.statSync(base + '/app.asar/out/main/' + entry).isFile()) throw new Error('Missing desktop process entry: ' + entry);
  }
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  const parser = new Parser();
  parser.setLanguage(Bash);
  const tree = parser.parse('echo packaged-tree-sitter');
  const win = process.platform === 'win32';
  const terminal = pty.spawn(win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', win ? ['/d', '/s', '/c', 'echo packaged-pty'] : ['-lc', 'printf packaged-pty'], {
    cols: 80, rows: 24, cwd: process.cwd(), env: process.env
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('node-pty packaged spawn timed out')), 10000);
    terminal.onData((data) => { output += data; });
    terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error('node-pty child exited ' + exitCode)); });
  });
  process.stdout.write(JSON.stringify({ version: manifest.version, electron: process.versions.electron, sharp: sharp.versions.sharp, vips: sharp.versions.vips, png: png.length, pty: output.includes('packaged-pty'), tree: tree.rootNode.type, cua }) + '\n');
  process.exit(0);
})().catch((error) => process.stderr.write(String(error?.stack || error) + '\n', () => process.exit(1)));`;

const result = spawnSync(appExecutable, ['-e', probe], {
  cwd: packageRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COS_RESOURCES_DIR: resourcesDir },
  encoding: 'utf8',
  timeout: 30_000
});
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
const runtime = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
if (runtime.version !== expectedVersion || runtime.electron !== expectedElectronVersion || !runtime.sharp || !runtime.vips || runtime.png <= 0 || !runtime.pty || runtime.tree !== 'program' || runtime.cua !== (cuaSupported ? CUA_DRIVER.version : null)) {
  throw new Error(`Packaged native runtime probe failed: ${JSON.stringify(runtime)}`);
}
process.stdout.write(`Packaged ${targetPlatform}-${targetArch} resources and native runtimes verified for ${expectedVersion}.\n`);

// Copy the actual packaged bundle to a temporary module root. This avoids resolving
// the checkout's devDependencies when the package itself lives under release/.
const profile = mkdtempSync(path.join(tmpdir(), 'wgpt-packaged-daemon-'));
const daemonEntry = path.join(profile, 'out', 'daemon', 'index.js');
mkdirSync(path.dirname(daemonEntry), { recursive: true });
copyFileSync(required('app.asar.unpacked/out/daemon/index.js'), daemonEntry);
symlinkSync(path.join(resourcesDir, 'app.asar.unpacked', 'node_modules'), path.join(profile, 'node_modules'), targetPlatform === 'win32' ? 'junction' : 'dir');
try {
  createRequire(daemonEntry).resolve('electron');
  throw new Error('Packaged daemon unexpectedly resolves an Electron installation');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const dataDir = path.join(profile, 'data');
const daemonEnv = { ...process.env, HOME: profile };
delete daemonEnv.ELECTRON_RUN_AS_NODE;
delete daemonEnv.NODE_PATH;
const daemon = spawn(process.execPath, [daemonEntry, '--data-dir', dataDir, '--json'], {
  cwd: profile,
  env: daemonEnv,
  stdio: ['ignore', 'pipe', 'pipe']
});
let daemonOutput = '';
let daemonError = '';
const daemonExited = new Promise((resolve) => daemon.once('exit', resolve));
daemon.stdout.setEncoding('utf8').on('data', (chunk) => { daemonOutput += chunk; });
daemon.stderr.setEncoding('utf8').on('data', (chunk) => { daemonError += chunk; });
const cliEntry = path.join(resourcesDir, 'app.asar', 'out', 'cli', 'index.js');
function daemonCommand(command) {
  const result = spawnSync(appExecutable, [cliEntry, 'daemon', command, '--data-dir', dataDir, '--json'], {
    cwd: profile,
    env: { ...daemonEnv, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 20_000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packaged daemon ${command} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}
try {
  let startupTimer;
  const ready = await Promise.race([
    new Promise((resolve, reject) => {
      daemon.stdout.on('data', () => {
        const line = daemonOutput.split(/\r?\n/).find((part) => part.startsWith('{'));
        if (line) { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } }
      });
      daemon.once('error', reject);
      daemon.once('exit', (code) => reject(new Error(`Plain Node daemon exited ${code}: ${daemonError || daemonOutput}`)));
    }),
    new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error(`Plain Node daemon startup timed out: ${daemonError || daemonOutput}`)), 20_000); })
  ]).finally(() => clearTimeout(startupTimer));
  if (ready.daemon !== 'ready' || ready.data_dir !== dataDir || !ready.pid) throw new Error(`Unusable daemon readiness: ${JSON.stringify(ready)}`);
  const status = daemonCommand('status');
  if (status.kind !== 'daemon' || status.pid !== ready.pid || status.instance_id !== ready.instance_id || status.data_dir !== dataDir || !status.endpoint.startsWith('http://127.0.0.1:') || status.tunnel?.state !== 'off' || status.browser?.enabled !== false) {
    throw new Error(`Packaged daemon status mismatch or nonlocal endpoint: ${JSON.stringify(status)}`);
  }
  const stopped = daemonCommand('stop');
  if (stopped.stopping !== true || stopped.instance_id !== ready.instance_id) throw new Error(`Packaged daemon stop mismatch: ${JSON.stringify(stopped)}`);
  let stopTimer;
  const exit = await Promise.race([
    daemonExited,
    new Promise((_, reject) => { stopTimer = setTimeout(() => reject(new Error('Plain Node daemon did not exit after clean stop')), 10_000); })
  ]).finally(() => clearTimeout(stopTimer));
  if (exit !== 0) throw new Error(`Plain Node daemon exited ${exit} after stop: ${daemonError}`);
  process.stdout.write(`Packaged plain Node daemon status and clean stop verified in isolated profile.\n`);
} finally {
  if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM');
  let killTimer;
  await Promise.race([
    daemonExited,
    new Promise((resolve) => { killTimer = setTimeout(() => { daemon.kill('SIGKILL'); resolve(); }, 5_000); })
  ]).finally(() => clearTimeout(killTimer));
  rmSync(profile, { recursive: true, force: true });
}
