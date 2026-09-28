/**
 * `ApplyPatchFileUpdateMode` from `codex-rs/apply-patch/src/lib.rs`.
 *
 * Controls how updates reconstruct the target file after matching a patch.
 */
export type ApplyPatchFileUpdateMode =
  /** Preserve the historical behavior of normalizing updated files to LF. */
  | 'normalize_to_lf'
  /** Preserve existing line endings and use the file's preferred ending for new lines. */
  | 'preserve_line_endings';

/** Rust's `#[default]` variant. Codex only selects the other one behind a feature flag. */
export const DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE: ApplyPatchFileUpdateMode = 'normalize_to_lf';
