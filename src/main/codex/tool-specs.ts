/**
 * The model-visible text adapted from Codex's tool specs in
 * `codex-rs/core/src/tools/handlers/shell_spec.rs`, `view_image_spec.rs` and
 * `apply_patch_spec.rs`.
 *
 * These strings are the tools' actual contract with the model. Local changes describe batching,
 * retained results and connector output limits. Where Codex switches on `cfg!(windows)` this uses `process.platform`,
 * which is the same decision made at run time instead of compile time.
 */

import { defaultUserShell, isWindowsPowerShell5 } from './shell.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Whether the shell `exec_command` launches is the one without `&&` and `||`.
 *
 * Not the same question as "is this Windows": `defaultUserShell()` prefers `pwsh.exe`, so on a
 * PowerShell 7 machine the operators work and saying otherwise would cost the model a working line.
 */
export const LAUNCHES_WINDOWS_POWERSHELL_5 = IS_WINDOWS && isWindowsPowerShell5(defaultUserShell().shellPath);

/** `windows_shell_guidance()`. */
export const WINDOWS_SHELL_GUIDANCE = `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;

/**
 * Said on the tool the launch goes through, because `tools/list` is re-sent every turn while the
 * session instructions are read once. On 2026-09-02 a prime testing its game could not get a
 * foreground reading out of the browser window it controlled, and instead of reusing that one
 * window it launched a fresh debug instance on a new port and profile for every retry — five
 * browsers, each one resident, and a CPU running hot for a benchmark it never got. The rule is
 * one of restraint rather than prohibition: a browser it actually uses is fine, a replacement
 * per attempt is not.
 */
export const BROWSER_LAUNCH_GUIDANCE =
  'Browsers: do not spawn a new browser/profile/debug port per attempt; reuse the open window.';

export const EXEC_COMMAND_DESCRIPTION = IS_WINDOWS
  ? `Runs a command; returns output or a session ID.\n\n${WINDOWS_SHELL_GUIDANCE}\n\n${BROWSER_LAUNCH_GUIDANCE}`
  : `Runs a command; returns output or a session ID.\n\n${BROWSER_LAUNCH_GUIDANCE}`;

/**
 * Codex's text is 'Shell command to execute.'; two measured additions.
 *
 * Windows PowerShell 5.1 has no `&&` or `||` at all, and recorded sessions show the model reaching
 * for them and getting a parse error that names the token without saying the feature is missing.
 * Separately, 109 recorded exec calls were a file being read through the shell, which `read` does
 * better and without the exec capability. Both live on the parameter because `tools/list` is
 * re-sent every turn while the session instructions are read once.
 */
export const EXEC_COMMAND_CMD_DESCRIPTION = LAUNCHES_WINDOWS_POWERSHELL_5
  ? 'Shell command; use read for files. PowerShell 5.1: no && or ||, use cmds.'
  : 'Shell command; use read for files.';

export const EXEC_COMMAND_CMDS_DESCRIPTION =
  'Use cmd or cmds, not both. cmds runs sequentially in one shell; sections show per-command exit codes. Continues after ordinary non-zero exits; first non-zero exit wins.';

export const EXEC_COMMAND_WORKDIR_DESCRIPTION = 'Working directory; defaults to the turn cwd.';

export const EXEC_COMMAND_TTY_DESCRIPTION = 'True allocates a PTY; false or omitted uses pipes.';

export const EXEC_COMMAND_YIELD_TIME_DESCRIPTION =
  'Wait before yielding. Defaults to 10000 ms; range 250-30000 ms. Finished commands return immediately.';

/** The requested model-facing terminal budget; the runtime clamps it to its retained-output ceiling. */
export const MAX_OUTPUT_TOKENS_DESCRIPTION =
  'Approximate output token budget. Defaults to 65536; larger requests are capped at 262144.';

export const EXEC_COMMAND_SHELL_DESCRIPTION = "Shell binary to launch. Defaults to the user's default shell.";

export const EXEC_COMMAND_LOGIN_DESCRIPTION =
  IS_WINDOWS
    ? 'True loads the shell profile. Defaults to false on Windows.'
    : 'True runs the shell with -l/-i. Defaults to true.';

export const WRITE_STDIN_DESCRIPTION =
  'Polls or writes to a session ID. Empty chars reread retained output; never reruns work.';

export const WRITE_STDIN_SESSION_ID_DESCRIPTION = 'Session ID, running or completed.';

export const WRITE_STDIN_CHARS_DESCRIPTION = 'Bytes to write; empty polls without writing.';

export const WRITE_STDIN_YIELD_TIME_DESCRIPTION =
  'Writes: 250 ms default, 30000 ms cap. Empty polls: 5000-300000 ms, early on output.';

/**
 * `APPLY_PATCH_LARK_GRAMMAR` (`core/src/tools/handlers/apply_patch.lark`).
 *
 * On Codex this grammar *is* the schema: `apply_patch` is `ToolSpec::Freeform`, so the model is
 * given the grammar and emits raw patch text against it. MCP advertises JSON object schemas only,
 * so the grammar moves into the description -- otherwise the model would lose the exact syntax
 * spec that Freeform hands it.
 */
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

/**
 * Codex's description is "The `apply_patch` tool can be used to edit files. This is a FREEFORM
 * tool, so do not wrap the patch in JSON."
 *
 * The second sentence cannot survive the move to MCP -- here the patch *is* carried in JSON, as
 * the single `patch` string -- so it is replaced by the truth about this transport and followed by
 * the grammar the Freeform spec would otherwise supply. Matching and update semantics stay
 * ported from Codex; local guidance and bounded mismatch diagnostics help callers correct edits.
 */
export const APPLY_PATCH_DESCRIPTION = `Edit files: pass the patch text as the \`patch\` string.

Per Update File block: edits in file order, quoting current text for old/context lines; matching searches forward. On a mismatch use the diagnostic and correct the patch.

Grammar:

${APPLY_PATCH_LARK_GRAMMAR}`;

export const APPLY_PATCH_ARGUMENT_DESCRIPTION =
  'Patch text, *** Begin Patch through *** End Patch, per the grammar.';
