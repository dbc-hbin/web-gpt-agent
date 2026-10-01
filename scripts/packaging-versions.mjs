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
  version: 'v0.0.15',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: '571e0d59ed9e86d1b105dc34f3267865f654de6968b01efd7c847f0af657d11d' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '9dcae1e2fb121287e73271edb7b853dda52aa86b7bfca1df91bc275371261bdb' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'b2cae3aa9df45b4c2fe9b1d700ebacce39f9feb6a6b46b86e6499f9a51bf72ff' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '8c836dc5d68d68b663d9a5c5b28ff9fa780d9f7a3fffb1c306880b8f32fab5f1' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'c51bfd883fc22e3445494a03c0179875176564bde470661b308fd83af5d01abb' })
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
