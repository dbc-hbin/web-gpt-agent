/**
 * Port of `codex-rs/apply-patch/src/invocation.rs`'s apply_patch command interception parser.
 *
 * Codex deliberately uses Tree-sitter Bash even when the outer shell is PowerShell or cmd: the
 * accepted script shape is shell-agnostic and intentionally tiny. This port uses the exact same
 * tree-sitter-bash 0.25.1 grammar version as upstream rather than approximating the query with a
 * regex.
 */

import nodePath from 'node:path';
import Parser from 'tree-sitter';
import Bash from 'tree-sitter-bash';

import { ApplyPatchError, PatchParseError } from './errors.js';
import { parsePatch, type ApplyPatchArgs } from './parser.js';

const APPLY_PATCH_COMMANDS = new Set(['apply_patch', 'applypatch']);

type ApplyPatchShell = 'unix' | 'powershell' | 'cmd';

export type MaybeApplyPatch =
  | { kind: 'body'; args: ApplyPatchArgs }
  | { kind: 'patch_parse_error'; error: PatchParseError }
  | { kind: 'not_apply_patch' };

export type MaybeApplyPatchVerified =
  | { kind: 'body'; args: ApplyPatchArgs }
  | { kind: 'correctness_error'; error: ApplyPatchError }
  | { kind: 'not_apply_patch' };

function usesWindowsConvention(cwd: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\');
}

function classifyShellName(shell: string, cwd: string): string | null {
  const pathApi = usesWindowsConvention(cwd) ? nodePath.win32 : nodePath.posix;
  const basename = pathApi.basename(shell);
  if (basename === '') return null;
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  return stem.toLowerCase();
}

function classifyShell(shell: string, flag: string, cwd: string): ApplyPatchShell | null {
  const name = classifyShellName(shell, cwd);
  if ((name === 'bash' || name === 'zsh' || name === 'sh') && (flag === '-lc' || flag === '-c')) return 'unix';
  if ((name === 'pwsh' || name === 'powershell') && flag.toLowerCase() === '-command') return 'powershell';
  if (name === 'cmd' && flag.toLowerCase() === '/c') return 'cmd';
  return null;
}

function canSkipFlag(shell: string, flag: string, cwd: string): boolean {
  const name = classifyShellName(shell, cwd);
  return (name === 'pwsh' || name === 'powershell') && flag.toLowerCase() === '-noprofile';
}

function parseShellScript(argv: readonly string[], cwd: string): { shell: ApplyPatchShell; script: string } | null {
  if (argv.length === 3) {
    const [shell, flag, script] = argv;
    if (shell === undefined || flag === undefined || script === undefined) return null;
    const shellType = classifyShell(shell, flag, cwd);
    return shellType === null ? null : { shell: shellType, script };
  }
  if (argv.length === 4) {
    const [shell, skipFlag, flag, script] = argv;
    if (shell === undefined || skipFlag === undefined || flag === undefined || script === undefined) return null;
    if (!canSkipFlag(shell, skipFlag, cwd)) return null;
    const shellType = classifyShell(shell, flag, cwd);
    return shellType === null ? null : { shell: shellType, script };
  }
  return null;
}

// Verbatim `APPLY_PATCH_QUERY` from upstream `invocation.rs`.
const APPLY_PATCH_QUERY = String.raw`
(
  program
    . (redirected_statement
        body: (command
                name: (command_name (word) @apply_name) .)
        (#any-of? @apply_name "apply_patch" "applypatch")
        redirect: (heredoc_redirect
                    . (heredoc_start)
                    . (heredoc_body) @heredoc
                    . (heredoc_end)
                    .))
    .)

(
  program
    . (redirected_statement
        body: (list
                . (command
                    name: (command_name (word) @cd_name) .
                    argument: [
                      (word) @cd_path
                      (string (string_content) @cd_path)
                      (raw_string) @cd_raw_string
                    ] .)
                "&&"
                . (command
                    name: (command_name (word) @apply_name))
                .)
        (#eq? @cd_name "cd")
        (#any-of? @apply_name "apply_patch" "applypatch")
        redirect: (heredoc_redirect
                    . (heredoc_start)
                    . (heredoc_body) @heredoc
                    . (heredoc_end)
                    .))
    .)
`;

const bashLanguage = Bash as unknown as Parser.Language;
const query = new Parser.Query(bashLanguage, APPLY_PATCH_QUERY);

function extractApplyPatchFromBash(script: string): { body: string; workdir: string | null } | null {
  try {
    const parser = new Parser();
    parser.setLanguage(bashLanguage);
    const tree = parser.parse(script);

    for (const match of query.matches(tree.rootNode)) {
      let body: string | null = null;
      let workdir: string | null = null;
      for (const capture of match.captures) {
        if (capture.name === 'heredoc') {
          body = capture.node.text.replace(/\n+$/g, '');
        } else if (capture.name === 'cd_path') {
          workdir = capture.node.text;
        } else if (capture.name === 'cd_raw_string') {
          const raw = capture.node.text;
          workdir = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
        }
      }
      if (body !== null) return { body, workdir };
    }
    return null;
  } catch {
    // Upstream reports parser/grammar failures as `ShellParseError`, which exec_command treats as
    // "not intercepted" and therefore falls through to ordinary shell execution.
    return null;
  }
}

/** `maybe_parse_apply_patch`: recognize only Codex's explicit direct/heredoc invocation forms. */
export function maybeParseApplyPatch(argv: readonly string[], cwd: string): MaybeApplyPatch {
  if (argv.length === 2 && argv[0] !== undefined && argv[1] !== undefined && APPLY_PATCH_COMMANDS.has(argv[0])) {
    try {
      return { kind: 'body', args: parsePatch(argv[1]) };
    } catch (error) {
      if (error instanceof PatchParseError) return { kind: 'patch_parse_error', error };
      throw error;
    }
  }

  const shell = parseShellScript(argv, cwd);
  if (shell === null) return { kind: 'not_apply_patch' };
  const extracted = extractApplyPatchFromBash(shell.script);
  if (extracted === null) return { kind: 'not_apply_patch' };
  try {
    const args = parsePatch(extracted.body);
    args.workdir = extracted.workdir;
    return { kind: 'body', args };
  } catch (error) {
    if (error instanceof PatchParseError) return { kind: 'patch_parse_error', error };
    throw error;
  }
}

/**
 * The parse half of `maybe_parse_apply_patch_verified_with_mode`.
 * Verification stays in `index.ts` so the same ported verifier can be supplied the connector's
 * filesystem path resolver.
 */
export function maybeParseApplyPatchForExec(argv: readonly string[], cwd: string): MaybeApplyPatchVerified {
  if (argv.length === 1 && argv[0] !== undefined) {
    try {
      parsePatch(argv[0]);
      return { kind: 'correctness_error', error: ApplyPatchError.implicitInvocation() };
    } catch (error) {
      if (!(error instanceof PatchParseError)) throw error;
    }
  }

  const shell = parseShellScript(argv, cwd);
  if (shell !== null) {
    try {
      parsePatch(shell.script);
      return { kind: 'correctness_error', error: ApplyPatchError.implicitInvocation() };
    } catch (error) {
      if (!(error instanceof PatchParseError)) throw error;
    }
  }

  const parsed = maybeParseApplyPatch(argv, cwd);
  if (parsed.kind === 'patch_parse_error') {
    return { kind: 'correctness_error', error: ApplyPatchError.fromParseError(parsed.error) };
  }
  return parsed;
}
