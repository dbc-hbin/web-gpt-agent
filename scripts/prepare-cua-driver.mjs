import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUA_DRIVER } from './packaging-versions.mjs';
import { parseTarget, tarExecutableForPlatform } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'node_modules', '.cache', 'cua-driver');
const { platform, arch } = parseTarget();
const target = CUA_DRIVER.targets[platform][arch];
const release = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER.version}`;
const source = `https://codeload.github.com/trycua/cua/tar.gz/${CUA_DRIVER.sourceCommit}`;
const licenseUrl = `https://raw.githubusercontent.com/trycua/cua/${CUA_DRIVER.sourceCommit}/LICENSE.md`;
const output = path.join(root, 'resources', 'packaging', 'desktop', platform, arch);
const executableName = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function verifiedDownload(url, file, expected) {
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes && sha256(bytes) === expected) return bytes;
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Cua Driver download failed (${response.status}): ${url}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`Cua Driver SHA-256 mismatch: ${url}`);
  await writeFile(file, bytes);
  return bytes;
}

await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
const archive = path.join(cache, target.archive);
await verifiedDownload(`${release}/${target.archive}`, archive, target.sha256);
const license = await verifiedDownload(licenseUrl, path.join(cache, 'LICENSE.md'), CUA_DRIVER.licenseSha256);

// Extract only the host-owned CLI binary, not the upstream installed app/daemon, SDK
// libraries, cursor-theme CLI, or services. The verified archive is the input authority.
const extraction = path.join(cache, `extract-${platform}-${arch}`);
await rm(extraction, { recursive: true, force: true });
await mkdir(extraction, { recursive: true });
execFileSync(tarExecutableForPlatform(), [platform === 'win32' ? '-xf' : '-xzf', archive, '-C', extraction, executableName], { stdio: 'inherit' });
const candidate = path.join(extraction, executableName);
if (!existsSync(candidate)) throw new Error(`Cua Driver archive is missing ${executableName}`);
const destination = path.join(output, executableName);
if (platform === 'darwin') {
  // Release publishes one universal archive; the app packages one thin architecture.
  execFileSync('lipo', [candidate, '-thin', target.thinArch, '-output', destination]);
} else {
  await copyFile(candidate, destination);
}
if (target.executableSha256 && sha256(await readFile(destination)) !== target.executableSha256) {
  throw new Error(`Cua Driver ${platform}-${arch} executable differs from reviewed release`);
}
if (platform !== 'win32') await chmod(destination, 0o755);
await writeFile(path.join(output, 'LICENSE.cua-driver.txt'), license);
await writeFile(path.join(output, 'SOURCE.cua-driver.json'), JSON.stringify({
  version: CUA_DRIVER.version,
  commit: CUA_DRIVER.sourceCommit,
  source,
  sourceSha256: CUA_DRIVER.sourceSha256,
  binary: `${release}/${target.archive}`,
  binarySha256: target.sha256,
  executableSha256: sha256(await readFile(destination))
}, null, 2) + '\n');
await rm(extraction, { recursive: true, force: true });
console.log(`Staged Cua Driver ${CUA_DRIVER.version} ${platform}-${arch} from verified upstream release.`);
