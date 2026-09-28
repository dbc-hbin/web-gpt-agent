import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(), read: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: ports.spawn }));
vi.mock('node:fs', () => ({ existsSync: ports.exists, readFileSync: ports.read }));
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import seal from '../scripts/afterpack-macos-adhoc-seal.mjs';
const context = { electronPlatformName: 'darwin', arch: 3, appOutDir: '/package', packager: { appInfo: { productFilename: 'Chat On Steroids' } } };
const mediaKeys = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription'
];
let presentMediaKeys: Set<string>;

function successfulSpawn(command: string, args: string[]) {
  if (command === 'plutil') {
    if (args[0] === '-convert') return { status: 0,
      stdout: JSON.stringify(Object.fromEntries([...presentMediaKeys].map(key => [key, 'usage declaration']))), stderr: '' };
    const key = args[1] ?? '';
    if (args[0] === '-remove') {
      presentMediaKeys.delete(key);
      return { status: 0, stdout: '', stderr: '' };
    }
  }
  return { status: 0, stdout: '',
    stderr: args.includes('--display') ? 'Identifier=com.chatonsteroids.app\nSignature=adhoc\nTeamIdentifier=not set\n' : '' };
}

const LOCAL = 'Web GPT Agent Local Signing';
const isSigningFile = (file: string) => file.includes('web-gpt-agent-signing');

beforeEach(() => {
  vi.resetAllMocks();
  presentMediaKeys = new Set(mediaKeys);
  // Default: a machine without the local signing keychain (CI and contributors).
  ports.exists.mockImplementation((file: string) => !isSigningFile(file));
  ports.read.mockReturnValue('generated-password\n');
  ports.spawn.mockImplementation(successfulSpawn);
});
const signs = () => ports.spawn.mock.calls.filter(call => call[0] === 'codesign' && call[1].includes('--sign')).map(call => call[1]);
it.each(['win32', 'linux'])('does not run macOS signing on %s', async platform => {
  await seal({ ...context, electronPlatformName: platform });
  expect(ports.spawn).not.toHaveBeenCalled();
});
it('removes unused media prompts while preserving the host screen-capture declaration', async () => {
  presentMediaKeys.add('NSScreenCaptureUsageDescription');
  await expect(seal(context)).resolves.toBeUndefined();
  expect([...presentMediaKeys]).toEqual(['NSScreenCaptureUsageDescription']);
});
it('accepts bundles with the unused declarations already absent', async () => {
  presentMediaKeys.clear();
  await expect(seal(context)).resolves.toBeUndefined();
  expect(ports.spawn.mock.calls.some(call => call[1][0] === '-remove')).toBe(false);
});
it.each(['read', 'remove', 'unchanged'])('refuses to seal when plist cleanup fails: %s', async failure => {
  ports.spawn.mockImplementation((command: string, args: string[]) => {
    if (command === 'plutil' && args[0] === (failure === 'read' ? '-convert' : '-remove')) {
      return failure === 'unchanged'
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: 'plist operation failed' };
    }
    return successfulSpawn(command, args);
  });
  await expect(seal(context)).rejects.toThrow(failure === 'unchanged' ? 'failed to remove' : 'plist operation failed');
  expect(ports.spawn.mock.calls.some(call => call[0] === 'codesign')).toBe(false);
});
it('fails packaging when verification fails or signing has no resource envelope', async () => {
  ports.spawn.mockImplementation((command: string, args: string[]) => {
    const result = successfulSpawn(command, args);
    return command === 'codesign' && args.includes('--verify')
      ? { status: 1, stdout: '', stderr: 'invalid resource seal' }
      : result;
  });
  await expect(seal(context)).rejects.toThrow('invalid resource seal');
  expect(ports.spawn.mock.calls.some(call => call[0] === 'codesign' && call[1].includes('--deep'))).toBe(false);

  vi.clearAllMocks();
  presentMediaKeys = new Set(mediaKeys);
  ports.exists.mockImplementation((file: string) => !file.endsWith('CodeResources') && !isSigningFile(file));
  ports.spawn.mockImplementation(successfulSpawn);
  await expect(seal(context)).rejects.toThrow('no bundle CodeResources');
});
it('rejects a TeamIdentifier even if codesign reports adhoc', async () => {
  ports.spawn.mockImplementation((command: string, args: string[]) => {
    const result = successfulSpawn(command, args);
    return command === 'codesign' && args.includes('--display')
      ? { status: 0, stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=TEAM123\n' }
      : result;
  });
  await expect(seal(context)).rejects.toThrow('trust-bearing');
});

it('seals ad-hoc without the local signing keychain', async () => {
  await expect(seal(context)).resolves.toBeUndefined();
  expect(signs().length).toBe(4);
  for (const args of signs()) { expect(args[args.indexOf('--sign') + 1]).toBe('-'); expect(args).not.toContain('--keychain'); }
  expect(ports.spawn.mock.calls.some(call => call[0] === 'security')).toBe(false);
});
it('signs every nested payload and the bundle with the stable local identity when present', async () => {
  ports.exists.mockReturnValue(true);
  ports.spawn.mockImplementation((command: string, args: string[]) => {
    if (command === 'security') return { status: 0, stdout: args[0] === 'find-identity' ? `  1) ABC "${LOCAL}" (CSSMERR_TP_NOT_TRUSTED)\n` : '', stderr: '' };
    if (command === 'codesign' && args.includes('--display'))
      return { status: 0, stdout: '', stderr: `Identifier=com.webgptagent.app\nAuthority=${LOCAL}\nTeamIdentifier=not set\n` };
    return successfulSpawn(command, args);
  });
  await expect(seal(context)).resolves.toBeUndefined();
  expect(signs().length).toBe(4);
  for (const args of signs()) { expect(args[args.indexOf('--sign') + 1]).toBe(LOCAL); expect(args).toContain('--keychain'); }
  const unlock = ports.spawn.mock.calls.find(call => call[0] === 'security' && call[1][0] === 'unlock-keychain');
  expect(unlock?.[1][2]).toBe('generated-password');
});
it('refuses a signing keychain without the local identity and honours the ad-hoc override', async () => {
  ports.exists.mockReturnValue(true);
  ports.spawn.mockImplementation((command: string, args: string[]) =>
    command === 'security' ? { status: 0, stdout: '0 valid identities found\n', stderr: '' } : successfulSpawn(command, args));
  await expect(seal(context)).rejects.toThrow('has no "Web GPT Agent Local Signing" identity');
  expect(signs()).toEqual([]);

  vi.stubEnv('WGA_MAC_SIGNING', 'adhoc');
  try {
    ports.spawn.mockClear();
    await expect(seal(context)).resolves.toBeUndefined();
    for (const args of signs()) expect(args[args.indexOf('--sign') + 1]).toBe('-');
  } finally { vi.unstubAllEnvs(); }
});
