import { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS } from './packaging-targets.mjs';

export { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS };

// The npm SDK and executable are built from the same Cua Driver Rust release.
// Standalone binary archives contain no installed CuaDriver.app or daemon service.
export const CUA_DRIVER = Object.freeze({
  version: '0.31.0',
  sourceCommit: '5272e492d61b96caf08e3bf434d91126c1f3dccc',
  sourceSha256: '8134337f2beb1854918d8bbc5aea22d7ae00de9838ce6426f275d7ba6734d191',
  licenseSha256: 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9',
  targets: Object.freeze({
    darwin: Object.freeze({
      x64: Object.freeze({ archive: 'cua-driver-rs-0.31.0-darwin-universal-binary.tar.gz', sha256: '06cd80b153bdf046dc067fb593e0fc648e780afa37a902ca0515ac25f32f9a4f', thinArch: 'x86_64', executableSha256: '346419a7c26ceb6c11a6091accd7d2fa8456f47de7af4a39aae0f6a16852d276' }),
      arm64: Object.freeze({ archive: 'cua-driver-rs-0.31.0-darwin-universal-binary.tar.gz', sha256: '06cd80b153bdf046dc067fb593e0fc648e780afa37a902ca0515ac25f32f9a4f', thinArch: 'arm64', executableSha256: '448f32c2925ad6f327a547584c5c20bedc6f59edf78ccea44d81dda6afe16b7c' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ archive: 'cua-driver-rs-0.31.0-linux-x86_64-binary.tar.gz', sha256: '59d7d027ad0f24410e88e0cf239a04f8e724de400b5c418fab259f3b5c285ff1' }),
      arm64: Object.freeze({ archive: 'cua-driver-rs-0.31.0-linux-arm64-binary.tar.gz', sha256: 'a960ffe07869846dde1e2a193c7c3236d530f31631b035c637b7dd701dd6dc6f' })
    }),
    win32: Object.freeze({
      x64: Object.freeze({ archive: 'cua-driver-rs-0.31.0-windows-x86_64-binary.zip', sha256: '461c7d4acd12685ab777fa4a3800e25f75d2f06e8a67ab7a1778701eb25e6728' }),
      arm64: Object.freeze({ archive: 'cua-driver-rs-0.31.0-windows-arm64-binary.zip', sha256: 'a65898dfaee3fe7f78671ed2db0b7dc06a3c297ab856a8b70bf7a8c69bf59b95' })
    })
  })
});

export const TUNNEL_CLIENT = Object.freeze({
  version: 'v0.0.20',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '99474aaa62ece303d7b661f2f46f932dcd560b489b540f817355da25be71bcf3' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: '24fdcc4f71d1c2269c4df349339ece2a0d1053de046be93b039af5d2c09d933b' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: 'a8933a472c18409d137fbdece70673dbd23446754fea88eb9e5653d3244b93eb' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'f4689e75a835f69f1bbb9c59de9c4debb8e9c9cbbdd2721aa93378b4b048fd33' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '2f06ce5a17425c74a827e7038692936e973ae388e7eec728c40efee1fb5f139d' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: '2d89946c23111eb910f1bd4e7c5c4bfedfd73ac0dc9828aefc36294cfeae491f' })
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
