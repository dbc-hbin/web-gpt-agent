import os from 'node:os';
import { DESKTOP_CAPABILITIES, type Capabilities, type PlatformInfo } from '../shared/types.js';

/** The packaged macOS app itself requires macOS 13 (Darwin 22). */
export function macOSDesktopAutomationSupported(release: string): boolean {
  const major = Number.parseInt(release.split('.')[0] ?? '', 10) || 0;
  return major >= 22;
}

export function desktopAutomationSupported(
  platform: NodeJS.Platform = process.platform,
  release?: string
): boolean {
  if (platform === 'win32') return true;
  if (platform !== 'darwin') return false;
  // An explicit cross-platform projection models a supported Mac. The real host uses its actual
  // Darwin release; native execution additionally requires the app-owned bundled driver.
  return release !== undefined || process.platform === 'darwin'
    ? macOSDesktopAutomationSupported(release ?? os.release())
    : true;
}

export function hostPlatformInfo(
  platform: NodeJS.Platform = process.platform,
  release?: string
): PlatformInfo {
  if (platform === 'win32') return { family: 'windows', name: 'Windows', desktopAutomation: true };
  if (platform === 'darwin') {
    return { family: 'macos', name: 'macOS', desktopAutomation: desktopAutomationSupported(platform, release) };
  }
  if (platform === 'linux') return { family: 'linux', name: 'Linux', desktopAutomation: false };
  return { family: 'other', name: platform, desktopAutomation: false };
}

/**
 * Keep browser screen/control portable while masking unsupported native clipboard access.
 * Driver tool registration checks availability separately; stored grants are never erased.
 */
export function capabilitiesForPlatform(
  capabilities: Capabilities,
  platform: NodeJS.Platform = process.platform,
  release?: string
): Capabilities {
  if (desktopAutomationSupported(platform, release)) return capabilities;
  const next = { ...capabilities };
  // Screen/control also govern the Chromium extension on every OS. Only native
  // clipboard capabilities disappear here; driver registration checks availability.
  for (const capability of DESKTOP_CAPABILITIES) if (capability !== 'screen' && capability !== 'control') next[capability] = false;
  return next;
}
