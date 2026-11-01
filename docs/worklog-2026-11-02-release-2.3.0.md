# Release 2.3.0 preparation

The user explicitly requested committing, pushing and publishing the current work. The release includes the integrated changes already on main as well as the native composer fix. App, lockfile, main-process and extension declarations are synchronized to 2.3.0; bridge protocol remains 16. CHANGELOG.md and docs/release-notes/v2.3.0.md describe the complete release scope.

## Checks before publication

- `npm run verify` passed: privacy and notice/source checks, TypeScript, 6,420 tests and 6 separately executed shutdown tests. The existing 86 skipped tests remain skipped.
- `npm run build` produced the desktop main/preload/renderer, CLI and Node daemon bundles. It reported non-fatal mixed static/dynamic-import and dependency annotation warnings.
- Publish preflight found tunnel-client v0.0.15 stale. The six official v0.0.19 archives were downloaded and their SHA-256 hashes independently matched against GitHub's asset digests before updating the seven pin values.
- The normal tunnel fetcher staged the verified native arm64 archive. Its binaries reported tunnel-client 0.0.19 and cloudflared 2026.10.2; `npm run verify:tunnel-current` passed. Distribution-supplied license, SPDX and cloudflared source-provenance files remain with the packaged binaries.
- The native composer change's signed-in acceptance and exact-byte/turn evidence are recorded in worklog-2026-11-02-native-composer-text.md.

## Approved unpublished-history cleanup

A mistakenly committed local resources symlink had already been removed from the current tree, but remained in unpublished history. The user explicitly approved removing that record before publication.

Only the unpublished origin/main..main range was filtered for the resources path. All 83 commits were retained, including empty commits and merge structure. Author/committer identities and timestamps, complete commit messages and contributor trailers were compared before and after and remained identical. The final tree object was unchanged. Published origin/main, other branch refs and existing tags were unchanged; the symlink blob is absent from the outgoing main history.

The original history remains under the local-only refs/backup/pre-v2.3.0-publication recovery reference. Only main and the explicit release tag are to be pushed; the backup and unrelated branches are excluded.

## Publication boundary

These are pre-publication checks, not a claim of completed remote packaging. The existing publish.yml workflow runs at the immutable v2.3.0 tag, verifies and packages all six native targets, assembles the extension and corresponding-source archives, and rechecks checksums before publishing. The GitHub Actions run and public release assets provide the publication evidence.
