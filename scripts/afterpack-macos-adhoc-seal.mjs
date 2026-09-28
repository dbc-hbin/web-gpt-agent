/**
 * Gives the packaged macOS app a valid ad-hoc seal, and refuses to ship one that is not valid.
 *
 * ## The bug this exists for
 *
 * Issue #66: the 2.0.5 arm64 DMG launched to "the application is damaged" on macOS 27, with
 * Gatekeeper assessment already disabled — so this was a structural failure, not a policy one:
 *
 *     codesign --verify --deep --strict "Web GPT Agent.app"
 *     -> code has no resources but signature indicates they must be present
 *     codesign -dvv -> flags=0x20002(adhoc,linker-signed), Sealed Resources=none
 *
 * `linker-signed` is the giveaway. Every arm64 Mach-O gets an ad-hoc signature from the linker
 * whether anyone asks or not — it is not optional on Apple Silicon. `identity: null` tells
 * electron-builder to skip bundle signing, so the app shipped as a *bundle* carrying signed
 * Mach-Os and no `_CodeSignature/CodeResources`. macOS reads the signature on the executable,
 * looks for the resource seal it implies, finds none, and calls the bundle damaged. There was
 * never an x64-only version of this problem, which is why it appeared with Apple Silicon.
 *
 * ## Why ad-hoc rather than Developer ID
 *
 * The release policy is deliberately unsigned and unnotarized, and this does not change that.
 * An ad-hoc seal carries no Authority and no TeamIdentifier — `codesign -dvv` still reports
 * `Signature=adhoc`, and Gatekeeper still will not vouch for it. What it adds is the resource
 * envelope the executable's own signature already claims exists. The bundle stops contradicting
 * itself; it does not become trusted. Users still clear quarantine as before.
 *
 * ## Why it verifies afterwards
 *
 * The real defect was that nothing checked. The bundle audit asserted the *absence* of a seal, so
 * the broken state was the state the build required, and two releases shipped it. Signing without
 * verifying would leave the same hole one layer along, so a failed verify fails the build.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoTrustBearingMacCodeSignature, LOCAL_MAC_SIGNING_IDENTITY } from './macos-audit-utils.mjs';

// A dedicated keychain holds the machine-local identity, so codesign never needs the user's
// login-keychain password. Its generated password lives beside it with owner-only access.
const SIGNING_KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'web-gpt-agent-signing.keychain-db');
const SIGNING_KEYCHAIN_PASSWORD = path.join(os.homedir(), 'Library', 'Application Support', 'web-gpt-agent-signing', 'keychain-password');

const UNUSED_MEDIA_PRIVACY_KEYS = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription'
];

/** Runs a command and returns its combined output, throwing with that output on failure. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${detail || result.error?.message || result.signal || result.status}`);
  }
  return result;
}

/**
 * Every local rebuild gets a new ad-hoc CDHash, and macOS drops Screen Recording/Accessibility
 * grants whose designated requirement no longer matches. A stable local identity keeps them.
 * Machines without that keychain (CI, contributors) keep the ad-hoc seal. WGA_MAC_SIGNING=adhoc
 * forces it.
 */
function signingIdentity() {
  if (process.env.WGA_MAC_SIGNING === 'adhoc' || !existsSync(SIGNING_KEYCHAIN) || !existsSync(SIGNING_KEYCHAIN_PASSWORD)) {
    return { sign: '-', args: [], label: 'ad-hoc' };
  }
  const password = readFileSync(SIGNING_KEYCHAIN_PASSWORD, 'utf8').trim();
  run('security', ['unlock-keychain', '-p', password, SIGNING_KEYCHAIN]);
  const found = run('security', ['find-identity', '-p', 'codesigning', SIGNING_KEYCHAIN]).stdout;
  if (!found.includes(`"${LOCAL_MAC_SIGNING_IDENTITY}"`)) {
    throw new Error(`${SIGNING_KEYCHAIN} exists but has no "${LOCAL_MAC_SIGNING_IDENTITY}" identity; remove it or set WGA_MAC_SIGNING=adhoc`);
  }
  return { sign: LOCAL_MAC_SIGNING_IDENTITY, args: ['--keychain', SIGNING_KEYCHAIN], label: `with ${LOCAL_MAC_SIGNING_IDENTITY}` };
}

export default async function sealMacOsBundle(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const app = path.join(context.appOutDir, appName);
  if (!existsSync(app)) throw new Error(`afterPack could not find ${app} to seal`);

  const plist = path.join(app, 'Contents', 'Info.plist');
  const originalPlist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plist]).stdout);
  for (const key of UNUSED_MEDIA_PRIVACY_KEYS) {
    if (Object.hasOwn(originalPlist, key)) run('plutil', ['-remove', key, plist]);
  }

  // Electron's generic app template declares camera/microphone/audio capture even when an app
  // never uses those APIs. CoS denies renderer permission requests and has no media-capture
  // feature, so shipping those declarations is misleading and can make macOS surface unrelated
  // privacy prompts. Keep only privacy declarations for capabilities CoS actually exposes.
  const cleanedPlist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plist]).stdout);
  for (const key of UNUSED_MEDIA_PRIVACY_KEYS) {
    if (Object.hasOwn(cleanedPlist, key)) throw new Error(`afterPack failed to remove unused Info.plist key ${key}`);
  }

  const resources = path.join(app, 'Contents', 'Resources');
  // builder-util Arch.x64=1 and Arch.arm64=3 (the hook receives the numeric enum).
  if (context.arch !== 1 && context.arch !== 3) throw new Error(`Unexpected macOS package architecture: ${context.arch}`);
  const arch = context.arch === 1 ? 'x64' : 'arm64';
  const native = path.join(resources, 'app.asar.unpacked', 'node_modules', '@trycua', `cua-driver-darwin-${arch}`);
  const identity = signingIdentity();
  // The loose child executable and native SDK live outside app.asar. Sign them as
  // nested code before sealing the host so neither has a stale linker/release signature.
  for (const file of [
    path.join(resources, 'desktop', 'cua-driver'),
    path.join(native, 'libcua_driver_sdk.dylib'),
    path.join(native, 'cua_driver_node_runtime.node')
  ]) {
    if (!existsSync(file)) throw new Error(`Missing embedded Cua Driver code: ${file}`);
    run('codesign', ['--force', ...identity.args, '--sign', identity.sign, file]);
    run('codesign', ['--verify', '--strict', file]);
  }

  // Electron nests frameworks and helper apps that each need their own signature. Signing only the outer
  // bundle would leave the same self-contradiction one level down. Apple discourages --deep for
  // *distribution* signing, where each nested component wants its own identity and entitlements;
  // for a uniform seal (ad-hoc or the one local identity) with no entitlements there is nothing
  // to distinguish.
  run('codesign', ['--force', '--deep', ...identity.args, '--sign', identity.sign, app]);

  // The check the two broken releases did not have. --strict so a seal that merely exists is not
  // mistaken for a seal that is coherent, and --deep so a nested framework cannot be the one
  // thing that is wrong, which is exactly how issue #66 presented.
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

  const shown = run('codesign', ['--display', '--verbose=4', app]);
  // Fail loudly if this ever starts producing a trust-bearing signature. The release notes say
  // unsigned, and an afterPack hook silently turning that into something Gatekeeper vouches for
  // would be a policy change smuggled in as a build step.
  // codesign displays these details on stderr even on success. Use the same
  // stdout+stderr policy as the standalone bundle audit, including TeamIdentifier.
  assertNoTrustBearingMacCodeSignature(app, shown, existsSync(path.join(app, 'Contents', '_CodeSignature', 'CodeResources')));

  process.stdout.write(`Sealed ${appName} ${identity.label} and verified its resource envelope.\n`);
}
