import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArch, normalizePlatform, PLATFORM_INFO } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function value(name, fallback) {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const platform = normalizePlatform(value('platform', process.platform));
const arches = value('arch', process.arch).split(',').map((item) => normalizeArch(item.trim()));
const dirOnly = args.includes('--dir');

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const node = process.execPath;
run(node, ['scripts/generate-third-party-notices.mjs']);
run(node, ['scripts/make-icon.mjs']);
// The same three electron-vite passes `npm run build` performs. The
// `wgpt` CLI is its own build into its own output directory (electron.vite.cli.config.ts), so
// the default config alone leaves `out/cli/index.js` unwritten. That file is what the packaged
// `bin/wgpt` wrapper resolves inside app.asar and what `files: ['out/**']` is supposed to carry,
// so a distribution built without it ships a CLI that cannot start. The standalone daemon
// also needs its own fresh bundle; a previous development build is not package input authority.
const electronVite = path.join('node_modules', 'electron-vite', 'bin', 'electron-vite.js');
run(node, [electronVite, 'build']);
run(node, [electronVite, 'build', '--config', 'electron.vite.cli.config.ts']);
run(node, [electronVite, 'build', '--config', 'electron.vite.daemon.config.ts']);

for (const arch of arches) {
  const targetArgs = ['--platform', platform, '--arch', arch];
  run(node, ['scripts/fetch-tunnel-client.mjs', ...targetArgs]);
  run(node, ['scripts/fetch-ripgrep.mjs', ...targetArgs]);
  run(node, ['scripts/prepare-packaging-native.mjs', ...targetArgs]);
  if (platform !== 'linux') run(node, ['scripts/prepare-cua-driver.mjs', ...targetArgs]);

  const builderArgs = [
    path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    PLATFORM_INFO[platform].builderFlag,
    `--${arch}`,
    '--publish',
    'never'
  ];
  if (dirOnly) builderArgs.push('--dir');
  run(node, builderArgs, { ...process.env, COS_PACKAGE_ARCH: arch });
}
