# Ordinary MCP terminals shared by process ID

The user reported an `exec_command` launch that yielded a process ID, followed by a `write_stdin` refusal because the next request could not prove the same local-session owner. The separate ownership check could refuse access to a retained process/output before consulting the process manager. The reported old process was not inspected.

On 2026-11-12 the user explicitly authorized access from other chats and requested removing this session binding, including stdin. This supersedes the cross-chat ownership requirement retained in the 2026-11-09 terminal-capacity work.

## Changes

- Ordinary `write_stdin` now addresses the app-lifetime process manager directly by `session_id`. Different chats, unresolved requests and headerless calls can poll or write an existing process ID.
- Removed the terminal ownership registry, ownership refusal branches, launch-time ownership bookkeeping and obsolete release callback. `executionPrincipal` remains for code-mode stores and search cursors, which keep their existing identity contracts.
- The manager still owns process-instance checks, interaction serialization, completed-input refusal and bounded retained output. Unknown IDs retain explicit unavailable-output guidance. Authenticated MCP access, current Command/Read-only permissions and known blocked/superseded/compacting caller restrictions remain.
- The product map describes shared terminal IDs. At the user's follow-up request, terminal tool descriptions omit session-binding and chat-identity commentary and retain output-collection/retention guidance. No output-push mechanism or additional result ledger was added.

## Validation

Before the change, the production MCP HTTP regression failed in all five identity transitions: foreign chat, unresolved poll request, headerless poll, identified poll after a headerless launch, and a different unresolved request. The failures were the original ownership/identity refusals.

The focused six-file terminal/code-mode/path/retention/mutex/parity run passed 231 tests with 10 existing conditional skips and exposed one invalid new Read-only fixture. That fixture set a label without computing the effective capabilities required by production ToolContext. It was corrected to use `effectiveCapabilities`; both permission cases then passed. They verify that refused stdin bytes do not reach the child.

Final `npm run verify` passed the ripgrep checksum, public-history privacy, dependency notices/native-source inventory, typecheck and Electron resolution. Its main run reported 223 passing files and 5,144 passing tests. Eight files failed solely because the pre-existing shared-tree deletion of `extension/chatgpt-dom.js` causes seven suite-load failures and four user-prompt test failures. The terminal changes and all changed test files passed in that run. The chained shutdown stage was not reached; `npm test -- --run test/mcp-shutdown.test.ts` separately passed all six tests.

Final `npm run build` passed for main, preload, renderer, CLI and daemon. It retained the existing dynamic/static import and dependency-comment warnings. The test-quality skill audit passed with no findings. The optional TypeScript skill audit crashed inside its own script because the installed TypeScript API lacks `ts.isParameter`; no passing audit is claimed.

The scoped `git diff --check` passed. Independent read-only code review reported no actionable findings and judged the change correct; it did not run checks or exercise the installed app.

Verification used isolated real MCP HTTP/code-mode calls and real child processes. No package, installation, running-backend restart, signed-in ChatGPT flow or inspection of the user's old process ID was performed. Unrelated deletions and the existing terminal-capacity worklog changes were preserved.

For the descriptions-only follow-up, the existing MCP terminal schema/discovery test passed (one test). The full verification and build results above precede that prose removal and were not rerun for it.
