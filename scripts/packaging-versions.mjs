import { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS } from './packaging-targets.mjs';

export { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS };

// The npm SDK and executable are built from the same Cua Driver Rust release.
// Standalone binary archives contain no installed CuaDriver.app or daemon service.
export const CUA_DRIVER = Object.freeze({
  version: '0.29.1',
  sourceCommit: '7a8f66ad04e62fccb18cca9965f2964fcaee124e',
  sourceSha256: '12d53edb0df963057a5581f40051ca96cbbe75d0b73898cd8d2c1653837da735',
  licenseSha256: 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9',
  targets: Object.freeze({
    darwin: Object.freeze({
      x64: Object.freeze({ archive: 'cua-driver-rs-0.29.1-darwin-universal-binary.tar.gz', sha256: 'ba47526554ea832b4a77566ee946ef3fac1c51bb5e8a0d3f0c150e1377740bc7', thinArch: 'x86_64', executableSha256: '53aab0dd43029b2b6dcd9219bf021c17c785322566d84cdbbe7cab20ed5fa6b5' }),
      arm64: Object.freeze({ archive: 'cua-driver-rs-0.29.1-darwin-universal-binary.tar.gz', sha256: 'ba47526554ea832b4a77566ee946ef3fac1c51bb5e8a0d3f0c150e1377740bc7', thinArch: 'arm64', executableSha256: '7a3d4270b2a5ea080a65f34fd6fe137ccc8a3546500506bd955d54ed28f5eb8c' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ archive: 'cua-driver-rs-0.29.1-linux-x86_64-binary.tar.gz', sha256: 'cf3acd8d7b6ce44917374463758ab6eae0c1e5295592a968fd496c7c8b3d36f1' }),
      arm64: Object.freeze({ archive: 'cua-driver-rs-0.29.1-linux-arm64-binary.tar.gz', sha256: '92ddc1bf01a68be543445d8cdd0df9900f0a0a43a17d251bf581a7c26cd5168b' })
    }),
    win32: Object.freeze({
      x64: Object.freeze({ archive: 'cua-driver-rs-0.29.1-windows-x86_64-binary.zip', sha256: '4b5ace1d784b3e4b0d41360408600eac2fa8f008931e07dca200b58e477621ac' }),
      arm64: Object.freeze({ archive: 'cua-driver-rs-0.29.1-windows-arm64-binary.zip', sha256: '6427e148d5ff322381124945b1870c134c025af219df0054c0027dc58b92569d' })
    })
  })
});

export const TUNNEL_CLIENT = Object.freeze({
  version: 'v0.0.14',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'fa775db8897df543dd4ba66404f69492a2acfbc6a291f10df27aced064a16568' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '75e10be774184fb42189e347b16eb6bc9fb0780135d8af714d34e30ce068dc53' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'b540493c5bdbcdbb755700c8e2e16597e28b1569e425007e0f73111047bd6a64' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: '2de3fb879a18edb847e0313592c912f1983685488290a7fdba7ac403e6a4fb0a' })
    })
  })
});

export const RIPGREP = Object.freeze({
  version: '15.2.0',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'x86_64', triple: 'pc-windows-msvc', extension: 'zip', sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5' }),
      arm64: Object.freeze({ upstreamArch: 'aarch64', triple: 'pc-windows-msvc', extension: 'zip', sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'x86_64', triple: 'apple-darwin', extension: 'tar.gz', sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1' }),
      arm64: Object.freeze({ upstreamArch: 'aarch64', triple: 'apple-darwin', extension: 'tar.gz', sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'x86_64', triple: 'unknown-linux-musl', extension: 'tar.gz', sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c' }),
      arm64: Object.freeze({ upstreamArch: 'aarch64', triple: 'unknown-linux-musl', extension: 'tar.gz', sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915' })
    })
  })
});
