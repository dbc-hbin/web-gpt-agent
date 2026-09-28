import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIR_LINK, makeTempDir, removeTempDir } from './helpers.js';
// @ts-ignore js-yaml is a transitive electron-builder dependency; tests only need its runtime parser.
import { load as loadYaml } from 'js-yaml';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingVersions from '../scripts/packaging-versions.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingTargets from '../scripts/packaging-targets.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { assertReleaseAbsent } from '../scripts/check-release-absent.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { assertCurrentTunnelRelease } from '../scripts/verify-current-tunnel.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as macOSAuditUtils from '../scripts/macos-audit-utils.mjs';
const { RIPGREP, TUNNEL_CLIENT } = packagingVersions;
const {
  assertCompatibleMacOSDeploymentTargets,
  assertNoTrustBearingMacCodeSignature,
  macOSDeploymentTargetsFromOtool,
  withOtoolSafePath
} = macOSAuditUtils;
const {
  normalizeArch,
  normalizePlatform,
  PLATFORM_INFO,
  sharpPackagesFor,
  SUPPORTED_ARCHES,
  SUPPORTED_PLATFORMS,
  tarExecutableForPlatform,
  unpackedDirectoryPattern
} = packagingTargets;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function yamlFile(relative: string): any {
  return loadYaml(readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
}

describe('cross-platform packaging targets', () => {
  it('normalizes supported OS spellings and rejects unsupported targets', () => {
    expect(normalizePlatform('windows')).toBe('win32');
    expect(normalizePlatform('macos')).toBe('darwin');
    expect(normalizePlatform('linux')).toBe('linux');
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(() => normalizePlatform('freebsd')).toThrow(/Unsupported packaging platform/);
    expect(() => normalizeArch('ia32')).toThrow(/Unsupported packaging architecture/);
  });

  it('pins tunnel-client and ripgrep for every release OS/CPU pair', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      for (const arch of SUPPORTED_ARCHES) {
        expect(TUNNEL_CLIENT.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(RIPGREP.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(PLATFORM_INFO[platform].builderFlag).toMatch(/^--(?:win|mac|linux)$/);
      }
    }
    expect(RIPGREP.targets.linux.x64.triple).toBe('unknown-linux-musl');
    expect(RIPGREP.targets.linux.arm64.triple).toBe('unknown-linux-musl');
  });

  it('fails closed unless the pinned tunnel-client is OpenAI\'s current stable release', async () => {
    const response = (body: Record<string, unknown>, status = 200) => async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      });

    await expect(assertCurrentTunnelRelease({
      pinnedVersion: 'v0.0.14',
      fetchImpl: response({ tag_name: 'v0.0.14', draft: false, prerelease: false })
    })).resolves.toMatchObject({ tag_name: 'v0.0.14' });
    await expect(assertCurrentTunnelRelease({
      pinnedVersion: 'v0.0.13',
      fetchImpl: response({ tag_name: 'v0.0.14', draft: false, prerelease: false })
    })).rejects.toThrow(/v0\.0\.13 is stale.*v0\.0\.14/);
    await expect(assertCurrentTunnelRelease({
      pinnedVersion: 'v0.0.14',
      fetchImpl: response({ message: 'rate limited' }, 403)
    })).rejects.toThrow(/refusing to publish without proving the pin is current/);
  });

  it('selects only target Sharp packages and unpacked directory families', () => {
    expect(sharpPackagesFor('win32', 'x64')).toEqual(['@img/sharp-win32-x64']);
    expect(sharpPackagesFor('darwin', 'arm64')).toEqual([
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64'
    ]);
    expect(sharpPackagesFor('linux', 'x64')).toEqual([
      '@img/sharp-linux-x64',
      '@img/sharp-libvips-linux-x64'
    ]);
    expect(unpackedDirectoryPattern('win32').test('win-arm64-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('darwin').test('mac-arm64')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('linux-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('mac-arm64')).toBe(false);
  });

  it('uses the host archive command spelling on every CI operating system', () => {
    expect(tarExecutableForPlatform('win32')).toBe('tar.exe');
    expect(tarExecutableForPlatform('darwin')).toBe('tar');
    expect(tarExecutableForPlatform('linux')).toBe('tar');
  });

  it('keeps scripts for all six release targets and legacy Windows aliases', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const script of [
      'dist', 'dist:x64', 'dist:arm64',
      'dist:mac:x64', 'dist:mac:arm64',
      'dist:linux:x64', 'dist:linux:arm64'
    ]) expect(pkg.scripts[script]).toBeTypeOf('string');
  });

  /**
   * The `wgpt` CLI is a second electron-vite pass with its own config, so a distribution script
   * that runs only the default pass leaves `out/cli/index.js` unwritten — the exact file the
   * packaged `bin/wgpt` wrapper resolves inside app.asar. This runs `scripts/package.mjs` itself
   * against a minimal fixture: the real electron-vite binary builds real bundles from the real
   * configs, and only the network fetchers, icon/notice generators and electron-builder are
   * stubbed, because a distribution target is otherwise unreachable from a test.
   */
  it('builds runnable CLI and daemon bundles for a distribution target', async () => {
    const fixture = await makeTempDir('packaging-cli-');
    try {
      await fs.mkdir(path.join(fixture, 'scripts'), { recursive: true });
      for (const script of ['package.mjs', 'packaging-targets.mjs']) {
        await fs.copyFile(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
      }
      for (const config of ['electron.vite.config.ts', 'electron.vite.cli.config.ts', 'electron.vite.daemon.config.ts']) {
        await fs.copyFile(path.join(root, config), path.join(fixture, config));
      }
      await fs.writeFile(
        path.join(fixture, 'package.json'),
        JSON.stringify({ name: 'packaging-fixture', version: '0.0.0', main: 'out/main/index.js' })
      );
      const fixtureFiles: Array<[string, string]> = [
        ['src/main/index.ts', "process.stdout.write('fixture-main\\n');\n"],
        ['src/main/backend.ts', "process.stdout.write('fixture-backend\\n');\n"],
        ['src/main/daemon-client.ts', "process.stdout.write('fixture-client\\n');\n"],
        ['src/preload/index.ts', 'export const preload = true;\n'],
        ['src/renderer/index.html', '<!doctype html><html><body>fixture</body></html>\n'],
        ['src/cli/index.ts', "process.stdout.write('fixture-cli\\n');\n"],
        ['src/daemon/entry.ts', "process.stdout.write('fixture-daemon\\n');\n"]
      ];
      for (const [file, content] of fixtureFiles) {
        await fs.mkdir(path.dirname(path.join(fixture, file)), { recursive: true });
        await fs.writeFile(path.join(fixture, file), content);
      }
      for (const script of [
        'generate-third-party-notices',
        'make-icon',
        'fetch-tunnel-client',
        'fetch-ripgrep',
        'prepare-packaging-native',
        'prepare-cua-driver'
      ]) {
        await fs.writeFile(path.join(fixture, 'scripts', `${script}.mjs`), 'process.exit(0);\n');
      }
      await fs.mkdir(path.join(fixture, 'node_modules', 'electron-builder', 'out', 'cli'), { recursive: true });
      await fs.writeFile(path.join(fixture, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), 'process.exit(0);\n');
      await fs.symlink(
        path.join(root, 'node_modules', 'electron-vite'),
        path.join(fixture, 'node_modules', 'electron-vite'),
        DIR_LINK
      );

      const result = spawnSync(
        process.execPath,
        ['scripts/package.mjs', '--platform', 'darwin', '--arch', 'arm64', '--dir'],
        { cwd: fixture, encoding: 'utf8', windowsHide: true }
      );
      if (result.error) throw result.error;
      expect(result.status, result.stderr).toBe(0);

      for (const output of ['out/main/index.js', 'out/main/desktop-backend.js', 'out/main/daemon-client.js', 'out/preload/index.js', 'out/renderer/index.html', 'out/cli/index.js']) {
        expect(existsSync(path.join(fixture, ...output.split('/'))), output).toBe(true);
      }

      // The wrapper executes this path inside app.asar, so a file that cannot run is not a CLI.
      const cli = spawnSync(process.execPath, [path.join(fixture, 'out', 'cli', 'index.js')], {
        cwd: fixture,
        encoding: 'utf8',
        windowsHide: true
      });
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stdout).toContain('fixture-cli');
      const daemon = spawnSync(process.execPath, [path.join(fixture, 'out', 'daemon', 'index.js')], {
        cwd: fixture,
        encoding: 'utf8',
        windowsHide: true
      });
      expect(daemon.status, daemon.stderr).toBe(0);
      expect(daemon.stdout).toContain('fixture-daemon');
    } finally {
      await removeTempDir(fixture);
    }
  });

  it('pins Electron 44.3.0 exactly and proves packaged runners use those runtime bytes', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const smoke = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');

    expect(pkg.devDependencies.electron).toBe('44.3.0');
    expect(lock.packages?.['']?.devDependencies?.electron).toBe('44.3.0');
    expect(lock.packages?.['node_modules/electron']?.version).toBe('44.3.0');
    expect(smoke).toContain('const expectedElectronVersion = sourcePackage.devDependencies?.electron;');
    expect(smoke).toContain('electron: process.versions.electron');
    expect(smoke).toContain('runtime.electron !== expectedElectronVersion');
  });

  it('grants sandbox read access only to the Windows install tree and fails on ACL errors', () => {
    const config = yamlFile('electron-builder.yml');
    const installer = readFileSync(path.join(root, 'scripts/windows-installer-acl.nsh'), 'utf8');
    expect(config.nsis.include).toBe('scripts/windows-installer-acl.nsh');
    expect(installer).toContain('!macro customInit');
    expect(installer).toContain('!macro customInstall');
    expect(installer).toContain('${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(installer).toContain('ExecWait');
    expect(installer).toContain('"$SYSDIR\\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"');
    expect(installer).toContain('${If} ${Errors}');
    expect(installer).toContain('${If} $0 != 0');
    expect(installer).toContain('SetErrorLevel 2');
    expect(installer).toContain('Abort "Windows could not set the folder access needed');
    expect(installer).not.toMatch(/\/(?:reset|remove|T)\b/i);
    expect(installer).not.toMatch(/(?:no-sandbox|disable-gpu-sandbox)/i);
  });

  it('assembles every platform artifact in the reusable release workflow', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    const parsed = yamlFile('.github/workflows/release.yml');
    const matrix = parsed.jobs.package.strategy.matrix.include;
    expect(matrix).toHaveLength(6);
    expect(matrix).toEqual([
      {
        name: 'Windows x64', platform: 'win32', arch: 'x64', runner: 'windows-2025',
        script: 'dist:x64', artifact: 'package-windows-x64', files: 'release/Web-GPT-Agent-Setup-x64.exe'
      },
      {
        name: 'Windows arm64', platform: 'win32', arch: 'arm64', runner: 'windows-11-arm',
        script: 'dist:arm64', artifact: 'package-windows-arm64', files: 'release/Web-GPT-Agent-Setup-arm64.exe'
      },
      {
        name: 'macOS x64', platform: 'darwin', arch: 'x64', runner: 'macos-15-intel',
        script: 'dist:mac:x64', artifact: 'package-macos-x64',
        files: 'release/Web-GPT-Agent-macOS-x64.dmg\nrelease/Web-GPT-Agent-macOS-x64.zip\n'
      },
      {
        name: 'macOS arm64', platform: 'darwin', arch: 'arm64', runner: 'macos-15',
        script: 'dist:mac:arm64', artifact: 'package-macos-arm64',
        files: 'release/Web-GPT-Agent-macOS-arm64.dmg\nrelease/Web-GPT-Agent-macOS-arm64.zip\n'
      },
      {
        name: 'Linux x64', platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04',
        script: 'dist:linux:x64', artifact: 'package-linux-x64',
        files: 'release/Web-GPT-Agent-Linux-x64.AppImage\nrelease/Web-GPT-Agent-Linux-x64.deb\n'
      },
      {
        name: 'Linux arm64', platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm',
        script: 'dist:linux:arm64', artifact: 'package-linux-arm64',
        files: 'release/Web-GPT-Agent-Linux-arm64.AppImage\nrelease/Web-GPT-Agent-Linux-arm64.deb\n'
      }
    ]);
    expect(parsed.jobs.package['runs-on']).toBe('${{ matrix.runner }}');
    expect(workflow).toContain('name: web-gpt-agent-candidate-${{ github.run_id }}');
    expect(workflow).toContain('Install generated DEB on target distro');
    expect(workflow).toContain('Launch installed DEB normally under Xvfb');
    expect(workflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/web-gpt-agent');
    expect(workflow).toContain('Execute generated static-runtime AppImage');
    expect(workflow).toContain('Verify generated macOS archives');
    expect(workflow).toContain('hdiutil verify "$dmg"');
    expect(workflow).toContain('codesign --display --verbose=4 "$dmg" >dmg-codesign.log 2>&1');
    expect(workflow).toContain('dmg_codesign_status=$?');
    expect(workflow).toContain("grep -Eqi 'code object is not signed( at all)?' dmg-codesign.log");
    expect(workflow).toContain('test -L "$mount_dir/Applications"');
    expect(workflow).toContain('test "$(readlink "$mount_dir/Applications")" = /Applications');
    expect(workflow).toContain('ditto -x -k "$zip" "$zip_dir"');
    expect(workflow).toContain("node scripts/smoke-macos-bundle.mjs '${{ matrix.arch }}' \"$mount_dir/Web GPT Agent.app\"");
    expect(workflow).toContain("node scripts/smoke-macos-bundle.mjs '${{ matrix.arch }}' \"$zip_dir/Web GPT Agent.app\"");
    expect(workflow).toContain('Audit packaged macOS bundle metadata and Mach-O payloads');
    expect(workflow).toContain('node scripts/smoke-macos-bundle.mjs ${{ matrix.arch }}');
    expect(workflow).toContain('Launch packaged macOS app normally');
    expect(workflow).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');
    expect(workflow).toContain('architecture: ${{ matrix.arch }}');

    const macGui = workflow.slice(
      workflow.indexOf('      - name: Launch packaged macOS app normally'),
      workflow.indexOf('      - name: Install generated DEB on target distro')
    );
    expect(macGui).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');
    expect(macGui).not.toContain('ELECTRON_RUN_AS_NODE');

    const macGuiScript = readFileSync(path.join(root, 'scripts', 'smoke-macos-gui.mjs'), 'utf8');
    expect(macGuiScript).toContain("CLF_DEBUG: '1'");
    expect(macGuiScript).toContain("output.includes('[info] app started')");
    expect(macGuiScript).toContain("output.includes('[info] window loaded')");
    expect(macGuiScript).toContain("output.includes('[info] renderer state ready')");
    expect(macGuiScript).toContain("output.includes('[error] window failed to load')");
    expect(macGuiScript).toContain("output.includes('[error] renderer:')");
    expect(macGuiScript).toContain('minimumSurvivalMs = 10_000');
    expect(macGuiScript).toContain('startupDeadlineMs = 15_000');
    expect(macGuiScript).toContain("child.kill('SIGTERM')");
    expect(macGuiScript).toContain("child.kill('SIGKILL')");
    expect(macGuiScript).not.toContain('ELECTRON_RUN_AS_NODE');

    const debGui = workflow.slice(
      workflow.indexOf('      - name: Launch installed DEB normally under Xvfb'),
      workflow.indexOf('      - name: Execute generated static-runtime AppImage')
    );
    expect(workflow).toContain('sudo apt-get install -y --no-install-recommends xvfb xauth');
    expect(workflow).toContain("grep -Fxq 'Name=Web GPT Agent' \"$desktop\"");
    expect(workflow).toContain("grep -Fxq 'Icon=web-gpt-agent' \"$desktop\"");
    expect(debGui).toContain('deb_smoke_root="$(mktemp -d)"');
    // Same shape the AppImage smoke below is held to: the teardown may retry, and may fail,
    // but it may never decide the step. Only the assertions under it do that.
    expect(debGui).toContain('cleanup_path_with_retries()');
    expect(debGui).toContain("trap 'cleanup_path_with_retries \"$deb_smoke_root\"' EXIT");
    expect(debGui).toContain('rm -rf "$target" 2>/dev/null || true');
    expect(debGui).toContain('HOME="$deb_smoke_root/home"');
    expect(debGui).toContain('XDG_CONFIG_HOME="$deb_smoke_root/config"');
    expect(debGui).toContain('XDG_CACHE_HOME="$deb_smoke_root/cache"');
    expect(debGui).toContain('XDG_DATA_HOME="$deb_smoke_root/data"');
    expect(debGui).toContain('XDG_STATE_HOME="$deb_smoke_root/state"');
    expect(debGui).toContain('xvfb-run -a /usr/bin/web-gpt-agent');
    expect(debGui).toContain('--kill-after=5s 12s');
    expect(debGui).toContain("grep -Fq '[info] app started' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] window loaded' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] renderer state ready' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] window failed to load' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] renderer:' deb-gui.log");
    expect(debGui).not.toContain('ELECTRON_RUN_AS_NODE');

    const appImageGui = workflow.slice(
      workflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      workflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageGui).toContain('xvfb-run -a "$appimage"');
    expect(appImageGui).toContain('normal_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('fallback_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('rm -rf "$fake_bin" "$normal_smoke_root" "$fallback_smoke_root"');
    expect(appImageGui).toContain('HOME="$smoke_root/home"');
    expect(appImageGui).toContain('XDG_CONFIG_HOME="$smoke_root/config"');
    expect(appImageGui).toContain('XDG_CACHE_HOME="$smoke_root/cache"');
    expect(appImageGui).toContain('XDG_DATA_HOME="$smoke_root/data"');
    expect(appImageGui).toContain('XDG_STATE_HOME="$smoke_root/state"');
    expect(appImageGui).toContain("printf '#!/bin/sh\\nexit 1\\n' > \"$fake_bin/unshare\"");
    expect(appImageGui).toContain('PATH="$launch_path"');
    expect(appImageGui).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(appImageGui).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] renderer state ready' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] window failed to load' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] renderer:' \"$log\"");
    expect(appImageGui).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(appImageGui).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(appImageGui.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('uses Noble-compatible Linux packages and a FUSE-independent AppImage runtime', () => {
    const builder = yamlFile('electron-builder.yml');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const iconScript = readFileSync(path.join(root, 'scripts', 'make-icon.mjs'), 'utf8');
    expect(builder.toolsets.appimage).toBe('1.0.3');
    expect(builder.linux.artifactName).toBe('Web-GPT-Agent-Linux-${env.COS_PACKAGE_ARCH}.${ext}');
    expect(builder.deb.depends).toContain('libgtk-3-0 | libgtk-3-0t64');
    expect(builder.deb.depends).toContain('libatspi2.0-0 | libatspi2.0-0t64');
    expect(builder.linux.syncDesktopName).toBe(true);
    expect(builder.linux.maintainer).toMatch(/^Web GPT Agent <[^>]+@users\.noreply\.github\.com>$/);
    expect(pkg.desktopName).toBe('com.webgptagent.app.desktop');
    expect(pkg.homepage).toBe('https://github.com/dbc-hbin/web-gpt-agent');
    expect(iconScript).toContain("build', 'icon.png'), pngFor(1024)");

    const packageScript = readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8');
    expect(packageScript).toContain('COS_PACKAGE_ARCH: arch');
    const releaseWorkflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(releaseWorkflow).toContain('HOME="$deb_smoke_root/home"');
    expect(releaseWorkflow).toContain('HOME="$smoke_root/home"');
    expect(releaseWorkflow).toContain('PATH="$launch_path"');
    expect(releaseWorkflow).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(releaseWorkflow).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(releaseWorkflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(releaseWorkflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/web-gpt-agent');
    expect(releaseWorkflow).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(releaseWorkflow).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Package)\" = web-gpt-agent");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Version)\" = \"$(node -p \"require('./package.json').version\")\"");
    expect(releaseWorkflow).toContain('expected_deb_arch=amd64');
    expect(releaseWorkflow).toContain('test -L /usr/bin/web-gpt-agent');
    expect(releaseWorkflow).toContain('installed_executable="$(readlink -f /usr/bin/web-gpt-agent)"');
    expect(releaseWorkflow).toContain('test -x "$installed_executable"');
    expect(releaseWorkflow).toContain('dpkg-query -S "$installed_executable"');
    expect(releaseWorkflow).toContain("node scripts/smoke-packaged-runtime.mjs --platform linux --arch '${{ matrix.arch }}' --root \"$(dirname \"$installed_executable\")\"");
    expect(releaseWorkflow).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');

    const appImageSection = releaseWorkflow.slice(
      releaseWorkflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      releaseWorkflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageSection.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('keeps the static AppImage sandbox fallback conditional and duplicate-safe', () => {
    // Read the shipped template rather than requiring app-builder-lib to render it. The
    // assertions below are on the template's own text, so loading that dependency graph buys
    // no coverage and is the reason this case could hit the global 30s timeout under full-suite
    // contention while passing in about 1.5s alone.
    const source = readFileSync(
      path.join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'appimage', 'appImageUtil.js'),
      'utf8'
    );

    expect(source).toContain('HAVE_NO_SANDBOX=0');
    expect(source).toContain('if [ "$arg" = --no-sandbox ] ; then');
    expect(source).toContain('if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then');
    expect(source).toContain('NO_SANDBOX=(--no-sandbox)');
    expect(source).toContain('exec "$BIN" "\\${NO_SANDBOX[@]}" "\\${args[@]}"');
  });

  it('hides Electron helper parentheses from otool-classic without changing the inspected file', () => {
    const file = '/Applications/Web GPT Agent.app/Contents/Frameworks/Web GPT Agent Helper (GPU).app/Contents/MacOS/Web GPT Agent Helper (GPU)';
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    const result = withOtoolSafePath(
      file,
      (safePath: string) => {
        calls.push({ kind: 'inspect', args: [safePath] });
        expect(path.basename(safePath)).toBe('payload');
        expect(safePath).not.toMatch(/[()]/);
        return 'otool-output';
      },
      {
        tmpdir: '/tmp',
        mkdtempSync: (prefix: string) => {
          calls.push({ kind: 'mkdtemp', args: [prefix] });
          return '/tmp/cos-otool-safe';
        },
        symlinkSync: (target: string, alias: string) => {
          calls.push({ kind: 'symlink', args: [target, alias] });
        },
        rmSync: (target: string, options: unknown) => {
          calls.push({ kind: 'remove', args: [target, options] });
        }
      }
    );

    expect(result).toBe('otool-output');
    const safePrefix = path.join('/tmp', 'cos-otool-');
    const safeDirectory = '/tmp/cos-otool-safe';
    const safePayload = path.join(safeDirectory, 'payload');
    expect(calls).toEqual([
      { kind: 'mkdtemp', args: [safePrefix] },
      { kind: 'symlink', args: [file, safePayload] },
      { kind: 'inspect', args: [safePayload] },
      { kind: 'remove', args: [safeDirectory, { recursive: true, force: true }] }
    ]);
  });

  it('rejects Mach-O payloads whose deployment target exceeds the declared macOS floor', () => {
    const modern = `
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 11.0
      sdk 15.0
Load command 11
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.15
      sdk 11.0
`;
    expect(macOSDeploymentTargetsFromOtool(modern)).toEqual(['11.0', '10.15']);
    expect(() => assertCompatibleMacOSDeploymentTargets('good.node', modern, '12.0')).not.toThrow();

    const tooNew = modern.replace('minos 11.0', 'minos 13.0');
    expect(() => assertCompatibleMacOSDeploymentTargets('desktop.node', tooNew, '13.0')).not.toThrow();
    expect(() => assertCompatibleMacOSDeploymentTargets('desktop.node', tooNew.replace('minos 13.0', 'minos 14.0'), '13.0')).toThrow(
      /requires macOS 14\.0, newer than Info\.plist LSMinimumSystemVersion 13\.0/
    );
    expect(() => assertCompatibleMacOSDeploymentTargets('bad.node', tooNew, '12.0')).toThrow(
      /requires macOS 13\.0, newer than Info\.plist LSMinimumSystemVersion 12\.0/
    );
    expect(() => assertCompatibleMacOSDeploymentTargets('missing.node', 'Load command 1\n cmd LC_SEGMENT_64', '12.0')).toThrow(
      /no macOS deployment target load command/
    );
  });

  it('allows Apple-Silicon ad-hoc signatures but rejects publisher-bearing macOS signatures', () => {
    // The sealed ad-hoc bundle, which is what ships: no Authority, no TeamIdentifier, and the
    // resource envelope its own executables imply.
    expect(() => assertNoTrustBearingMacCodeSignature('adhoc.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n'
    }, true)).not.toThrow();

    expect(() => assertNoTrustBearingMacCodeSignature('developer-id.app', {
      status: 0,
      stdout: '',
      stderr: 'Signature size=9000\nAuthority=Developer ID Application: Example Corp (TEAM123456)\nTeamIdentifier=TEAM123456\n'
    }, true)).toThrow(/trust-bearing code signature/);
    // The machine-local self-signed identity: one leaf Authority, no Apple chain, no team.
    expect(() => assertNoTrustBearingMacCodeSignature('local.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nAuthority=Web GPT Agent Local Signing\nTeamIdentifier=not set\n'
    }, true)).not.toThrow();
    for (const [name, stderr] of [
      ['other-self-signed.app', 'Authority=Someone Else\nTeamIdentifier=not set\n'],
      ['local-name-with-chain.app', 'Authority=Web GPT Agent Local Signing\nAuthority=Apple Root CA\nTeamIdentifier=not set\n'],
      ['local-name-with-team.app', 'Authority=Web GPT Agent Local Signing\nTeamIdentifier=TEAM123456\n'],
      ['adhoc-with-authority.app', 'Signature=adhoc\nAuthority=Web GPT Agent Local Signing\nTeamIdentifier=not set\n']
    ]) {
      expect(() => assertNoTrustBearingMacCodeSignature(name, { status: 0, stdout: '', stderr }, true)).toThrow(/trust-bearing code signature/);
    }
    expect(() => assertNoTrustBearingMacCodeSignature('unknown-success.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\n'
    }, true)).toThrow(/trust-bearing code signature/);
    expect(() => assertNoTrustBearingMacCodeSignature('inspection-failed.app', {
      status: null,
      stdout: '',
      stderr: 'codesign was terminated unexpectedly'
    }, true)).toThrow(/inspection failed unexpectedly/);
  });

  /**
   * Issue #66: the shape that shipped twice and would not launch.
   *
   * arm64 Mach-Os are ad-hoc signed by the linker whether anyone asks or not, so a bundle with no
   * CodeResources is one whose executables claim a resource seal the bundle does not have. macOS
   * reads that contradiction as damage — with Gatekeeper assessment already disabled, and no
   * crash report to show for it. This assertion used to *demand* that state, which is why two
   * releases shipped it and nothing caught them.
   */
  it('rejects a bundle whose executables are signed but which has no resource seal', () => {
    expect(() => assertNoTrustBearingMacCodeSignature('linker-signed.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n'
    }, false)).toThrow(/no bundle CodeResources envelope/);

    // "Never signed at all" earns the same refusal. The seal is what macOS needs, and a packaged
    // arm64 app cannot reach that state anyway — the linker signs it regardless.
    expect(() => assertNoTrustBearingMacCodeSignature('unsigned.app', {
      status: 1,
      stdout: '',
      stderr: 'code object is not signed at all'
    }, false)).toThrow(/no bundle CodeResources envelope/);
  });

  it('fails release-existence preflight closed on API errors instead of spending packaging runners', async () => {
    const options = {
      repository: 'owner/repo',
      tag: 'v2.0.2',
      token: 'test-token'
    };
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('', { status: 404 })
    })).resolves.toBeUndefined();
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{}', { status: 200 })
    })).rejects.toThrow(/already exists/);
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{"message":"rate limited"}', { status: 403 })
    })).rejects.toThrow(/refusing to assume the release is absent/);
  });

  it('rejects invalid publishes before allocating the reusable six-runner build', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const preflight = workflow.indexOf('  preflight:');
    const candidate = workflow.indexOf('  candidate:');
    const publish = workflow.indexOf('  publish:');
    expect(preflight).toBeGreaterThan(-1);
    expect(candidate).toBeGreaterThan(preflight);
    expect(publish).toBeGreaterThan(candidate);
    expect(workflow.slice(preflight, candidate)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow.slice(preflight, candidate)).toContain('npm run verify:tunnel-current');
    expect(workflow.slice(preflight, candidate)).toContain('Verify release metadata agrees');
    expect(workflow.slice(preflight, candidate)).toContain("APP_VERSION = '([^']+)'");
    expect(workflow.slice(preflight, candidate)).toContain('has no release title');
    expect(workflow.slice(candidate, publish)).toContain('needs: preflight');
    expect(workflow.slice(publish)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow.slice(publish).match(/npm run verify:tunnel-current/g)).toHaveLength(1);
    expect(workflow).toContain('name: web-gpt-agent-candidate-${{ github.run_id }}');
  });

  it('keeps version metadata aligned and validates artifacts independently of editorial release notes', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
    const versionSource = readFileSync(path.join(root, 'src', 'main', 'version.ts'), 'utf8');
    const tag = `v${pkg.version}`;
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const notes = readFileSync(path.join(root, 'docs', 'release-notes', `${tag}.md`), 'utf8');
    const publish = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const release = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.['']?.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(versionSource.match(/APP_VERSION = '([^']+)'/)?.[1]).toBe(pkg.version);
    expect(changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1]).toBe(pkg.version);
    expect(notes).toMatch(/^## .+$/m);

    const artifacts = [
      'Web-GPT-Agent-Setup-x64.exe',
      'Web-GPT-Agent-Setup-arm64.exe',
      'Web-GPT-Agent-macOS-x64.dmg',
      'Web-GPT-Agent-macOS-x64.zip',
      'Web-GPT-Agent-macOS-arm64.dmg',
      'Web-GPT-Agent-macOS-arm64.zip',
      'Web-GPT-Agent-Linux-x64.AppImage',
      'Web-GPT-Agent-Linux-x64.deb',
      'Web-GPT-Agent-Linux-arm64.AppImage',
      'Web-GPT-Agent-Linux-arm64.deb',
      'Web-GPT-Agent-Extension.zip',
      'SHA256SUMS.txt'
    ];
    const checksumStep = release.slice(
      release.indexOf('      - name: Create SHA-256 checksums'),
      release.indexOf('      - name: Upload release candidate')
    );
    const candidateUpload = release.slice(release.indexOf('      - name: Upload release candidate'));
    const publishStep = publish.slice(publish.indexOf('      - name: Publish the release'));
    for (const artifact of artifacts) {
      expect(candidateUpload).toContain(artifact);
      expect(publishStep).toContain(artifact);
    }
    for (const artifact of artifacts.filter((artifact) => artifact !== 'SHA256SUMS.txt')) {
      expect(checksumStep).toContain(artifact);
    }
  });
});
