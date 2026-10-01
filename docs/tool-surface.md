# Model-facing tool surface

This is the current public reference for the tool surface. The implementation and tests are
authoritative; `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`,
`src/main/mcp/tools-desktop.ts`, `src/main/mcp/tools-work-control.ts`,
`src/main/mcp/tools-external.ts` and the MCP suites should agree with this file.

## Connectors

Web GPT Agent publishes Core on Windows, macOS and Linux. Windows and macOS additionally publish
the optional Desktop connector, and every platform publishes the optional Plugins connector.
They are separate discovery and permission boundaries and use separate secret tokenized local
paths. **Core is the only connector a normal session needs.**

| Connector name | MCP server name | Purpose | Public tools |
| --- | --- | --- | --- |
| **Web GPT Agent** | `web-gpt-agent-core` | File access under the saved mode, patches, terminal, plans, workers, durable work, external MCP gateway | `exec_read`, `exec`, `wait`, `tools_search`, `work`; `agents` when multi-agent is enabled; optional `session_finish` |
| **Web GPT Agent Desktop** | `web-gpt-agent-desktop` | Optional browser, native windows, input and clipboard | `exec`, `wait`, `tools_search` |
| **Web GPT Agent Plugins** | `web-gpt-agent-plugins` | Optional external MCP integrations | `exec`, `wait`, `tools_search` |

The Core connector name is the bare brand — there is no `Core` suffix, because Core *is* the
connector. Desktop and Plugins keep a suffix because they are genuinely separate optional
connectors, each with its own tunnel and its own token.

The **embedded CUA engine is not a Plugins installation or connector.** Core retains its
managed `mcp_tools` / `mcp_call` gateway under the reserved `cua-driver` server identity.
Desktop exposes the engine's native tool names and upstream schemas inside `exec` / `wait`.
Both use one Electron-backend-owned runtime and private endpoint, never an external daemon.

On a fresh current config, Core permissions are enabled, along with
session recording and multi-agent mode; read-only mode is off. Windows also enables Desktop
permissions; macOS starts them off and the user switches them on. Linux masks
Desktop permissions off at runtime while preserving stored choices for a config later reopened on
Windows or macOS. Existing configs keep explicit choices during upgrades; missing legacy permissions are
not silently widened.

Core exposes the wrappers and eligible lifecycle tools listed above; each optional endpoint
exposes three wrappers. Ordinary tools are not direct MCP handlers: their existing implementations
are called through `tools["name"](args)` inside code mode. Core reads prefer `exec_read`;
mutating or mixed scripts use `exec`. There are no old-name compatibility aliases.
`tools_search` returns the live capability-filtered catalog, even when a connector has no
available backend tools. Every child call rechecks current permissions and file-access mode.

First call `tools_search` with no arguments for a bounded summary, then request exact schemas
with `{ "names": ["read", "apply_patch"] }` or a `query`. Default page size is 5, maximum 20;
repeat the selection with `next_offset` to continue. Exact schemas retain `$defs`, output
schemas and annotations. Pages are capped at 64 KiB; an oversized single schema is refused,
never clipped. Discovery requires connector authentication, not browser/worker identity.

The partition follows OMP’s direct-tool/JavaScript-bridge design. Core nested calls and the
exec/wait execution contract follow `openai/codex@94174e44cbc54cece45f6052328ca0c2cd7a8a2a`.
MCP still carries JavaScript in `{code}` rather than a freeform Responses tool, and this
implementation uses isolated QuickJS cells rather than Codex’s JavaScript engine. Cells and
JSON state are bounded process memory, not a persistent REPL or restart-durable storage.

## Core tools

Unless identified below as direct lifecycle tools, these names are discovered with
`tools_search` and called inside Core `exec_read` or `exec`. Emit concise results with `text(...)`, or native
MCP image content with `image(...)`; un-emitted values stay inside the script.

### `read`

Reads paths under the saved file-access mode. Approved folders only is the default; explicitly
enabling All files also accepts native absolute paths outside approved roots, while existing
virtual aliases remain. An unscoped search with no approved roots still needs a path. It accepts
one or more paths, lists a directory one level deep, expands
bounded globs, supports line ranges, and can return supported image content. Path resolution
and result-size limits are enforced by the app: the per-file default payload is 256 KB
(`max_bytes` may raise it to the 512 KB hard cap), and the aggregate payload for one call stays
bounded at 512 KB — a batch stops with an explicit "output cap reached" line rather than
silently truncating. The defaults are set so that batching paths into one call and reading a
file whole are the cheap path, because the round trip costs far more than the bytes.
Model-facing line previews
are clipped at 512 Unicode characters with an explicit marker and the exact source path/line
range; a clipped line is never presented as the full source.

### `view_image`

The dedicated Codex-compatible image tool. It is a real Core tool, separate from `read`, and
is gated by the read capability. It returns `{image_url: "data:<mime>;base64,…"}` inside Core
code mode; use `image(await tools.view_image({path: "/workspace/image.png"}))` to emit it.
Image transport and decode checks remain bounded.

### `find`

The structured search tool, backed by the bundled ripgrep. It covers filename/glob search
(`mode: 'name'`, the default) and text search (`mode: 'content'`), without granting a shell.

It takes exactly one of `query` or `cursor`, plus optional `path`, `include`, `exclude`,
`case_sensitive`, `regex` (content mode only), and `max_results` (default 50, max 500). A managed
worker call that omits `path` defaults to that worker's assigned worktree, not every approved root.

Both ordinary and managed searches return the same native object inside `exec` and `exec_read`;
emit it with `text(await tools.find({...}))`. Direct MCP results carry the same complete JSON
and structured content. `read` remains a text result.

Results come back as bounded retained pages: the response carries `hits`, `next_cursor`,
`truncated`, `stopped_because`, `elapsed_ms`, `files_scanned`, `engine: 'ripgrep'`,
`content_file_limit` and page counters. Paging passes only `cursor` and `max_results`, returns
the retained snapshot, and never re-runs the query. Errors are explicit: an invalid regex is a
tool error, `SEARCH_ENGINE_UNAVAILABLE` when the bundled ripgrep is missing,
`SEARCH_CURSOR_INVALID` / `SEARCH_CURSOR_EXPIRED` for a bad or deleted retained page, and
`SEARCH_RESULT_TOO_LARGE` when one record cannot fit the 32 KiB response bound. Zero matches is
success. `clipped` and `line_chars` identify shortened line previews; read that file/line for
the full text. Page completion does not imply complete coverage when `stopped_because` is set.
Legacy managed pages without scan metadata return null, not invented zero counts. Ordinary
multi-root scans share one ten-second deadline. `SEARCH_SCOPE_REQUIRED` means there was no
search scope; this is not a successful zero-match result.
Invalid regex/glob patterns and invalid or expired cursors are recorded as `tool_rejected`,
not connector failures. Cursor errors retain their `SEARCH_CURSOR_*` code and recovery
guidance. Corrupt retained pages and actual search-engine failures remain
`tool_internal_error`; classification uses typed errors, not matching arbitrary error text.

Continuation follows the cursor's original storage, not the caller's current managed-work
status. An ordinary cursor remains readable after exact request/session proof establishes
a managed binding, subject to the same owner, approved-scope and expiration checks.

Ordinary snapshots last at most 15 minutes in this endpoint's process, with eight runs per
owner, 128 overall and a 64 MiB retained-byte bound. Capacity exhaustion is explicit; existing
cursors are not silently evicted. Restart or endpoint replacement retires them. Identified
callers can page only their own exact request/session snapshots; anonymous cursors remain
unguessable bearer references in the anonymous namespace. Every page revalidates its original
canonical scopes against the current file-access mode and approved roots. Managed artifact cursors retain their durable
work/session ownership and existing on-disk compatibility.

### `apply_patch`

The text mutation primitive. It uses the Codex-style patch envelope (`*** Begin Patch` with
`*** Add File:` / `*** Update File:` / `*** Move to:` / `*** Delete File:` hunks) and preflights
a multi-file patch before writing. Create, edit, move and delete-file permissions are checked
independently.
Directory deletion and arbitrary binary writes are deliberately not hidden patch operations.
It is the intended editing path; there is no `edit` or search/replace alias.
Call `await tools.apply_patch(patchText)` with the raw string, not `{patch: patchText}`.
Success returns `{}`; failure throws the actual child error. File edits belong here, not
inside a shell heredoc passed to `exec_command`.

### `exec_command`

Runs a command in the host's real shell: PowerShell/cmd on Windows and the user's normal POSIX
shell on macOS/Linux. This permission is **not** confined to approved folders. Long-running
commands return an opaque `session_id` that `write_stdin` can continue.
Both terminal tools return their structured object directly inside Core code mode, including
`output`, `exit_code` and the applicable `session_id` or `completed_session_id`. There is no
surrounding `content`/`structuredContent` envelope to unwrap.
App-provided shell correction, partial-batch and recovery notes are included in `output`
as well as the recorded text result; the native object keeps its existing fields and exit code.

It takes exactly one of `cmd` (a single command) or `cmds` (up to 20 commands run sequentially
in one shell session). A batch shares one process, so variables, environment changes and the
working directory carry across its items; each item gets a labeled output section and its own
exit code, an ordinary non-zero result does not stop the rest, and the call's exit code is the
first non-zero one. Batching exists to spend one connector round trip instead of several on
related checks. The `apply_patch` interception and the benign-non-zero-exit classification
apply to single-command calls only.

Both terminal tools honor `max_output_tokens`. The default is 65,536 estimated tokens
(256 KiB); requests are clamped to 262,144 tokens (1 MiB), matching the existing raw
collection ceiling. The estimate uses four UTF-8 bytes per token, with small additional
truncation framing. An explicit lower budget still applies. Completed rereads retain only
the existing 256 KiB raw head/tail history; a larger budget cannot reconstruct discarded
bytes. Outer code-mode preview limits apply separately.

### `write_stdin`

Writes to or polls a live command session by `session_id`, with optional yield time and output
budget. A blank `chars` value is a poll rather than a separate process-status tool. An empty
poll returns as soon as the process produces output rather than holding the full yield window;
anything that arrives afterwards stays buffered for the next poll. A non-empty write keeps
Codex's collection-window behaviour so one interactive response is gathered whole.

### `update_plan`

Available while recording is enabled. Replaces the exact caller's displayed progress plan; it does
not execute queued work. Local history continues recording messages and real tool results for the
app transcript and continuation. There is no model-facing recording search/read tool.

Compact & Resume is app/browser orchestration. There is no model-visible `save_handoff` or
`resume_session` tool.

### `agents`

Direct lifecycle tool, outside `exec`, available while multi-agent mode is enabled. It has exactly five actions:

- `spawn` creates worker chats from one shared context plus per-worker tasks. Used once per run:
  a run that needs a worker again reuses one it already has. Each worker takes an optional
  `model` slug: the worker's chat opens with `?model=<slug>` in its fresh-chat URL, so a prime
  on a limited model can spawn workers on a cheaper one. Omitted means the account default;
  a slug ChatGPT does not recognise opens with the default too. The model is fixed for the
  life of that conversation, including across sleep/wake reuse. Each worker also takes an
  optional `reasoning_effort`: pro, none, minimal, low, medium, high, xhigh, max or ultra,
  forwarded on the open URL independently of `model` — a level never selects or changes the
  model, and omitting either inherits the default set in app settings, or the account default
  when no setting is chosen. The vocabulary is the one in `shared/session.ts`; `pro` is the
  ChatGPT browser Power tier and is listed here because a worker is a real browser chat.
- `message` sends one message or an all-or-nothing batch. Messaging a sleeping worker is what
  wakes it, in the chat it already has.
- `status` reports the run and workers, including who is asleep and how many worker slots are free.
- `finish` is a worker's handoff to the prime. It reports a result and puts that worker to sleep.
- `integrate` is the prime incorporating one finished worker's private branch into the work's
  integration worktree, under a per-worktree mutation lock. It requires that worker as `to`, and
  refuses with `WORKTREE_BUSY` while the prime still has a live mutation or process. The prime
  owns the worker's family, so a worker id from another run is never resolved.

Workers sleep rather than end. A worker that has reported keeps its ChatGPT conversation and
stays reusable; its worker slot is free while it sleeps, so the limit counts only workers that
are actually working. Waking one needs a free slot, reopens or refocuses that worker's own chat,
and types the prime's message into it as an ordinary user message. A worker becomes permanently
finished only when its chat reaches the context ceiling (400,000 tokens by the app's own session
accounting); crossing it never interrupts work in flight, it only makes the next stop the last one.
Workers never run Compact & Resume, automatically or manually: their conversation is their durable
agent identity, so the 400,000-token boundary changes only later revive eligibility and never opens
a replacement worker chat.

There is no model-supplied agent credential or `agent_key`. Worker/prime identity is bound to
the ChatGPT conversation using extension evidence; control calls fail closed when that identity
cannot be proven.

### `session_finish`

Direct lifecycle tool, outside `exec`, present only while Session finish is enabled. For the main conversation only, when a user prompt
explicitly asks for it: it receives queued instructions and plan checkpoints inside the same
working turn, and waits up to 25 seconds when held with no work remaining. It is not a progress
update and not a way to collect queued tasks; workers use `agents action=finish` instead.

### `exec_read`, `exec` and `wait`

`exec({code})` starts a fresh isolated JavaScript cell composing only this connector’s tools.
Top-level await, `Promise.all`, bounded `setTimeout`/`clearTimeout`, `exit()` and
`yield_control()` are available; ambient Node, imports, filesystem and network APIs are not.
Core tools return native values: ordinary text, terminal objects, `{}` for patches and
`{image_url}` for images. Core failures throw. Core `mcp_call` and every Desktop/Plugins
nested call instead retain their raw MCP envelope, including `isError` as data.

Core also publishes `exec_read({code})` with the same interpreter, output limits and cell
lifecycle. Its host-owned allowlist contains only `read`, `find`, `view_image`, `work_resume`
and `mcp_tools` (retained catalog inspection, not external execution). Each still checks live
permissions, current file-access scope and its own identity rules. Shell commands, terminal input,
patches, plans, checkpoints, lifecycle tools and external calls cannot run in this mode.
The host checks each dispatch; dynamic tool names and yielded cells cannot escape the list.
`wait` continues the original cell's scope, never upgrading it to ordinary `exec`. There is
no automatic fallback to a mutating call after refusal. An ordinary `exec` retains its
existing capabilities, even when another cell for the same owner is read-only.

`exec_read` is advertised read-only and non-destructive, without open-world tool access.
These labels describe an enforced boundary, not a shell-command classifier. Desktop and
Plugins retain `exec`; external read-only annotations alone cannot grant entry to this Core
allowlist. Bounded session scratch state and normal recording remain shared infrastructure.

An optional first line controls initial observation and output:

```js
// @exec: {"yield_time_ms":1000,"max_output_tokens":2000}
const result = await tools.exec_command({cmd: "printf hello", workdir: "/workspace"});
text(result.output);
```

An owned cell normally returns after completion or ten seconds. Both exec wrappers and wait deliver their
output in MCP `content` only, without an outer `structuredContent`. A still-running
result's text notice supplies the `cell_id` and wait guidance; call
`wait({cell_id, yield_time_ms?, max_tokens?, terminate?})` to collect later output. Yielding
does not pause the program: it continues in the background without a wait call. Each
emission is collected once, concurrent wait claims are exclusive, and a completed cell is
retired after collection. `terminate:true` stops its interpreter, not already-dispatched
tool effects. A terminal `session_id` is a different identity, polled with `write_stdin`.

`store(key, value)` and `load(key)` exchange JSON-cloned values across fresh cells of the
same trusted principal and connector. Exact request proof can promote a provisional owner
to its durable session; another chat or connector cannot borrow that state or wait on its
cells. Anonymous execution remains a single stateless call: it cannot yield a retained cell
or use shared state. Stop, Block and a committed frontend rebind retire the old execution;
unblocking or A→B→A navigation does not revive it. Session JSON state survives frontend
replacement, but neither cells nor state survive host shutdown.

`text`, `image`, `audio` and `generatedImage` explicitly emit results. Images use the normal
full decoder; audio requires bounded valid base64 and an audio MIME type, without claiming
codec decoding or playback. `generatedImage` emits its image and optional `output_hint` as
metadata; it never writes that path. `notify` uses MCP progress when available and always
buffers its text for the next result: this is not Codex custom-message injection or proof
that the model saw an asynchronous notification. Recorded audio uses the existing asset
store; no audio player or new artifact lookup tool is added.

Limits remain explicit: 64,000 UTF-16 source units, 2 seconds guest CPU, 32 MiB interpreter
memory, 32 child calls, 8 concurrent child calls, 64 timers and 4 emitted images. Owned
cells have a five-minute lifetime and at most four retained cells; uncollected completed
output expires after one minute. Anonymous calls have a 60-second elapsed limit. Each
store has 256 keys, 64 KiB per JSON value and 1 MiB total; all stores share 64 owners and
8 MiB. A refused write does not silently evict accepted state. If newly proved aliases
cannot fit their combined owner quota, adoption returns `STATE_LIMIT` and preserves all
original buckets instead of publishing a partial merge.

Core exec/exec_read/wait returns complete admitted output without a text preview cap by
default. Desktop and Plugins retain the 1 MiB (262,144 estimated tokens) default preview.
An explicit max_output_tokens/max_tokens still clips text at four UTF-8 bytes per token,
up to 4 MiB (1,048,576 tokens). Core has no cumulative or per-emission byte ceiling;
Desktop and Plugins retain 12 MiB per cell and per emission. All surfaces retain 32
emissions and four images per cell, guest resource bounds and each child tool's own
result budget. Delivered emissions are released from a running cell after exec/wait,
but the MCP transport materializes each complete response in memory. Large one-shot
results therefore still raise peak memory; emit only what the model needs. Preview
truncation is reported without stopping the script or turning success into failure.
Byte clipping does not preserve JSON syntax: a truncation
notice means the value is incomplete, not a JSON document to parse. Later wait calls
collect new emissions, not the clipped suffix of an already collected one. Full
validated output goes to the existing recorder for the exec/wait call that delivers it.
Recording must be enabled and storage/overflow limits still apply; text beyond the
8 Mi-character overflow ceiling is reported as lost from history even when its MCP
response was delivered. A notice is not proof of persistence.

Each child rechecks live permissions, file-access scope and its original owner and records its own
result. Ordinary coding and plugin calls do not inherit managed-work authority from a
conversation binding. `exec` and `wait` never automatically replay dispatched work.
`work`, `agents`, `session_finish` and wrapper `exec_read`/`exec`/`wait` stay outside scripts. An upstream
plugin named `exec` or `wait` remains its own callable tool, not wrapper recursion. On
Plugins, child inputs use `{arguments: {...upstreamInputs}, operation_id?: "UUID"}`; the
outer operation ID is not forwarded upstream and does not bind the call to a work.

### `work_checkpoint` and `work_resume`

The durable checkpoint pair for a managed work, distinct from the direct controls below.
`work_checkpoint` records the current summary, remaining items and verification references, and only
the prime may mark the work completed; `work_resume` reads the checkpoint, pending operations, or one
operation's result by id. These work-specific tools select their target using a
`work_id` (with an optional `agent_id`) in the arguments, or the managed conversation the call itself
belongs to — so a checkpoint can be written or read from a remote or headless client with no browser
page of its own, and an explicit `work_id` that is unknown, or an `agent_id` that does not belong to
it, is refused by name. Neither resumes a paused work — that is `work` action `control`.

An ordinary `agents` worker is not automatically a managed-work agent. With no arguments,
`work_resume` reads the proven conversation's connection from the restored work ledger:
`managed_connection: bound` includes its exact agent and work; `managed_connection: unbound`
means no managed assignment and reads no checkpoint. Unbound is a normal result, not a security
block, permission revocation or instruction to create a replacement work. An explicit work target
does not connect the calling conversation. Unknown caller identity, unavailable state and stale
or paused managed bindings retain their separate errors. `work_checkpoint` without a target
refuses a known unbound conversation with `WORK_NOT_BOUND`; ordinary coding and broker reporting
remain independent. Worker display names and worktree paths never establish managed ownership.

### `work` — six no-DOM actions

`work` takes `{ action, input }`, with action-specific input validation. It is registered
directly on Core under the same secret path and Host/Origin
checks. They deliberately do **not** require a browser page or a proven worker conversation,
because the caller they exist for is a phone conversation that has none. That is an internal
dispatch distinction, not a second connector, endpoint or tunnel.

- `start` requires `request_id`, `project_path` (absolute, existing, an approved Git repository) and
  `goal`; optional `title`, `model`, `reasoning`, `max_workers` (default 2, range 1–8). It
  admits durably and returns `{request_id, work_id, status: 'queued', revision}` at once,
  including the declared integration branch and worktree, then starts the prime conversation in
  the background. It genuinely launches the Mac main conversation and permits worker delegation.
- `list` accepts `cursor` and `limit` (default 20, max 100) and includes the configured
  projects so a new conversation can pick one.
- `status` takes one `work_id` and returns goal, project and result paths, `desired_state`,
  prime and worker summaries, blocker, checkpoint and pending commands. It never waits for a
  model response.
- `instruct` sends text to running work, delivered at the next safe turn boundary. It also
  carries the optional `resolve_operations` array described below. An instruction for a work that
  already completed is routed to the active end of its recorded continuation chain, and when that
  end is completed the ledger admits one durable successor: the receipt's `work_id` is then the
  work the instruction actually landed on, and `predecessor_work_id` is present. Every later
  instruction belongs to that `work_id`.
- `control` performs `pause`, `resume` or `cancel`. Pause and cancel commit the fence and
  the desired state first and drain asynchronously, so status keeps showing the true state plus
  `desired_state` until the drain finishes. Resume continues the same agent in the same worktree.
- `events` reads the durable event log from a `after` cursor (default 50, max 200) and
  returns `next_cursor`.

**Who may change work.** Any authenticated client of the connector. `start` names the project it is
starting in, and `instruct` and `control` name the `work_id` they are about; no browser page, proven
conversation, attached session or worker binding is required, and none is inferred. The caller's own
conversation metadata is *optional diagnostics*: when the page has said which conversation issued the
call and which user message it answers, that is used to dedup the message against the automatic
relay (the message's inbox row is claimed so the relay joins this admission instead of delivering it
again) and to attribute the call in the conversation's own timeline, and a `start` also makes that
conversation the work's controller when it has no binding yet — so the work's reports come back to
the chat that asked. Absence of that metadata costs the dedup and the attribution, never the call.

The ledger's own constraints are unchanged and are the only admission that matters: `request_id`
idempotency (the same id with the same payload returns the prior receipt; a different payload is
`REQUEST_ID_CONFLICT`), read-only mode and the command/edit capability check, and the approved-project
sandbox for `project_path`. An unknown `work_id` is refused with the service's own `WORK_NOT_FOUND`,
and a work that is paused, cancelled, completed or blocked refuses a control that does not apply.
Reads (`list`, `status`, `events`) mutate nothing and are always available.

`status` reports each pending command with a `delivery_state` of `pending`, `delivering`,
`queued`, `unknown`, `delivered`, `failed` or `cancelled`. Only `delivered` means the conversation
took the message: `queued` means the outbox accepted it and it is still waiting for its turn, and
`unknown` means the hand-off was attempted and its outcome cannot be established. A command in
`unknown` is **never resent as if it had not happened** — the outbox's own row is the
reconciliation, and a late acknowledgement flips it to `delivered` — and a work whose delivery
stays unconfirmed past the attempt budget is blocked with `INSTRUCTION_DELIVERY_UNKNOWN` until
that acknowledgement arrives.

Coding tools are independent of any work. `read`, `find`, `exec_command`, `apply_patch` and the
rest of the Core surface run for any authenticated caller from any ChatGPT conversation, with the
conversation metadata treated as optional diagnostics: a phone chat, a fresh chat, a scheduled run
and a host that has not restored its ledger all behave the same way, under the same permissions and
the same saved file-access mode. A working directory comes from the call's own arguments (`workdir`,
absolute paths), an approved root, or home with rootless All files — never from a directory remembered from an earlier
conversation.

A call becomes *managed* only by naming a work: `work_checkpoint` and `work_resume` accept an
explicit `work_id` (with an optional `agent_id`), and a call whose proven conversation the ledger
has bound to a *live* work is admitted through that binding with its usual receipts and generation
fence. A call that names no work gets no receipt, because it is not an operation of any work.

Only the work lifecycle commands (`agents`, `work_checkpoint`, `work_resume`) are answered by the
work they name: a work that is paused, cancelled, completed or unreachable refuses *those* by name.
The coding tools are never gated on a work's lifecycle — a chat whose work is paused, stale,
superseded or has no binding at all still reads, runs commands and patches files under its existing
permissions, which is what keeps a managed work from taking an ordinary chat's coding ability down
with it. Start,
instruct and resume require command/edit permissions and refuse read-only mode. Reads, pause and
cancel remain available. Provider account and client availability remain external prerequisites.

### Local connection and reconnect (CLI and app only)

Bringing an existing chat back is a local act, so it is deliberately **not** in the MCP `work`
action union: the model cannot open a page. `wgpt work connection <work_id>` reports, and
`wgpt work reconnect <work_id>` asks for that same chat to be brought back, both over the local
control socket (`work.connection`, `work.reconnect`).

The target is always something that already exists: `--agent-id` selects one of the work's own
agents (omitted means the current prime, and an agent that does not belong to that work — or to a
generation that is no longer current — is refused), and `--conversation-id` is an **exact
expected-chat fence**, never a rebind target. A caller that names the wrong chat is told so
instead of being quietly pointed at whatever the registry holds now. Nothing here creates a work,
an agent, a session or a conversation, and nothing here pauses, resumes or cancels: the work's own
lifecycle value is reported unchanged, and a paused or cancelled work is never revived by it.

The result separates the two facts that are easy to conflate:

- `work_state` — the ledger's own lifecycle value, reported as it is. A paused work is **not**
  closed: its page can still be reported and reopened, and reconnecting never resumes it.
- `state` — the page: `ready`, `opening`, `closed` or `unavailable`. Only `ready` means a current
  authenticated page sighting for this exact session/conversation, with the closed-chat
  suppression already cleared by the real page-return path. A bridge heartbeat, recorder activity
  or an attributed MCP call is not that evidence and never produces `ready`. `closed` means
  waiting cannot help — a cancelled work, a finished or failed agent, a session that no longer
  carries this conversation, a chat the user closed, or no page sighting since this host process
  started. `unavailable` means the target could not be resolved or the attempt failed, which is
  where a selector naming another agent's chat, or an agent with no bound conversation, lands
  instead of being repaired.
- `page_observed_at` and `browser_recovery_dismissed_at` — the two raw facts behind `ready`, so
  "never seen" and "seen but suppressed" stay distinguishable. `page_observed_at` is
  process-local: `null` means "not since this host process started", not "never". Both are `null`
  when the registry holds no such value, and `agent_id` / `generation` / `session_id` /
  `conversation_id` are explicitly `null` rather than guessed when there is no binding.

`reconnect` starts the exact dedicated-profile chat through the existing opener and coalesces
repeated or concurrent attempts, so a timeout never blindly opens a second tab. A wait that ends
without a sighting is `opening` with the wait named in `reason`; an open that actually failed is
`unavailable` with the launch error. The CLI exits `0` only for `ready` and `4` otherwise, so a
script can branch on it, and its socket deadline is longer than the wait the caller asked for.

### Companion controller conversations

A work's controller is the conversation whose messages are relayed to it and which receives its
reports. The app never binds one from a message it merely observed: a binding is created from
proven identity only — an explicit local bind (the **Works** pane's **Connect this chat**, which
names a local session and lets the host resolve its saved conversation), the first managed prime
that owns a work (so a work started here can be continued from the same chat), or a proven `work`
call that started the work. One work has one controller; connecting a different chat takes that
role over, and the previous binding is disabled rather than deleted. A binding records how it came
to exist: the runtime's own prime fallback is `automatic` and may be replaced, but only while the
work has no controller at all; a person's connection — the pane's press, a re-enable, a takeover —
is `explicit` and is never displaced by that fallback. Disabling — the pane's **Disconnect this
chat** — stops new relay and report delivery and never pauses, cancels or otherwise changes the
work.

The bound conversation is published on the authenticated companion status pass as
`controllerWatches: [{sessionId, conversationId, boundAt, providerAccountId, observationToken}]`
(`providerAccountId` is `null` until a read anchors it); only enabled bindings appear, and a
binding that is disabled, unbound or superseded simply stops appearing, which is the whole
cancellation protocol. Each watch is a question — "read this conversation under this authority" —
and the token is minted fresh by the host, travels with the watch, is echoed on every page of the
answer, and is rotated the moment the host accepts a complete read or the binding's authority
moves, so an answer produced under a previous authority cannot be accepted however well the rest of
it matches.

`POST /controller/observe` accepts one authenticated snapshot for such a conversation and answers
`409 not_controller_conversation` for a chat the host is not watching, `400 bad_request` for a body
that cannot be read and `400 bad_conversation_id` / `400 bad_controller_snapshot` for a missing or
malformed one, `409 controller_page_out_of_order` or `409 controller_page_authority_conflict` for a
window the host cannot place, `413 controller_snapshot_too_large` past the page cap, and
`422 controller_snapshot_refused` naming any row it could not admit. A branch longer than one body
travels as consecutive windows of one read, oldest first, under one `snapshotId`; the host applies
a read only once every window `0..count-1` has arrived in order under one unchanged authority, and
then admits and routes the concatenation in window order, so a backlog larger than one body is
admitted whole instead of losing its oldest requirement behind the newest one. A refused row is the
page's answer and ends the walk there — the branch is never handed over with a hole in it, because
a hole looks exactly like a message that was edited away. Admission itself is asynchronous and
ordered: only messages on that conversation's active branch are considered, oldest first, each
keyed by its provider message id so a retry cannot queue it twice, and a message that outlived the
host process must be re-proved by a fresh authenticated snapshot before it may execute. A read
commits its admissions, and then its routed work receipts, once per ordered chunk of 32 messages
rather than once per message: each message's frozen dispatch, work command and `accepted` state
land in the same commit, and nothing of the chunk is published until that commit succeeds.
Bridge protocol `16` is the fence for both directions.

The relay is not a second connector, endpoint or tunnel: it uses the same synced ChatGPT thread
the user already has, which is why the desktop companion has to be reachable and why a native
mobile MCP client is not a supported transport. The companion reads a bound conversation from the
provider's own conversation document rather than from a page — a chat written from a phone has no
tab anywhere — walking `current_node` back through real parent links so the active branch is
evidence rather than a sample, and posts one snapshot per bound conversation; the provider access
token never leaves that module and the host is told only the account id.

Both halves are tested — the host side against the bridge fixtures, the companion side against the
provider document shape with a stubbed fetch — but no live ChatGPT account or phone was driven end
to end, so a live successful sync is not claimed here.

### `mcp_tools` and `mcp_call`

The external-MCP gateway. A configured external server is never published as raw tools here, so
a large server catalog needs only the two gateway schemas on demand, and the caller has to name the
installation it means — two servers exporting the same raw tool name stay unambiguous.

- `mcp_tools` reads the **retained** catalog of one enabled installation: server identities, or
  paginated tool names/descriptions/annotations, or the complete input/output schema plus a
  `schema_hash` for one exact `{server_id, tool}`. It never connects, reconnects, authenticates
  or retries anything. A tool switched off in Plugins is retained and shown there, but is neither
  listed as callable nor returned as an exact schema.
- `mcp_call` re-validates that installation's current schema and the caller's `schema_hash`
  before dispatching, so a caller working from a superseded schema fails before invocation.
  Unknown installation, disabled server, disabled tool or changed hash fails before anything is
  sent. Because the installation's own lifecycle queue can replace a declaration, a connection or
  the policy while a call waits, the same check is re-proved inside that queue: a call admitted
  against a declaration that has since been replaced is refused rather than translated onto the
  newer one. The reserved embedded `cua-driver` route also refuses a runtime replacement
  during admission.

`mcp_tools` is read-only discovery; `mcp_call` is advertised as mutating. Annotations are hints, not
authority — only an exact installation+tool pair on the host-owned reviewed read-only list may
omit an operation receipt. The reserved `cua-driver` identity uses the embedded runtime's
reviewed catalog rather than an installed plugin; it retains managed prime ownership, the
desktop lease, snapshot provenance, generation fences and mutation receipts. Ordinary
external calls retain plugin enablement and the operation ledger, including nested calls.
The native route additionally obeys the same Screen, Control and individual Clipboard
capabilities as Desktop. Disabled native tools are absent from discovery and exact-schema
reads; saved schemas cannot bypass current permission. Native calls recheck permission
before dispatch and withhold results or driver errors if it changes before publication.
Possibly completed mutations remain explicitly uncertain rather than safe to replay.

Read-only mode refuses all external `mcp_call` dispatch, matching the separate Plugins surface.
`mcp_tools` discovery remains available. A tool's read-only annotation does not override this
permission boundary; identity, schema-hash and operation-receipt checks still apply when calls
are enabled.

## Desktop tools

Desktop retains public `exec`, `wait` and `tools_search` and the independent browser tools
listed below. Native desktop tools come from bundled **CUA Driver 0.31.0**, replacing the
former custom macOS addon, Swift helper and Windows PowerShell/Window2 facades. There is no
`sky`, `observe` or `computer` fallback. The Electron backend owns runtime startup/shutdown;
no external driver installation or socket is used. On macOS grant Web GPT Agent Screen
Recording and Accessibility, then recheck in Workspace to restart the embedded runtime.
Linux exposes browser tools but not native Desktop input.

### Browser tools

`browser_tabs`, `browser_snapshot`, `browser_screenshot`, `browser_console` and `browser_network`
read; `browser_navigate`, `browser_action` and `browser_evaluate` change page state. A tab handle
names one browser incarnation, never the selected or foreground tab, so a connected tab can be
read without stealing focus. Read-only mode disables input, navigation, tab creation/closure and
page JavaScript. These tools do not route through Cua Driver.

### Native Cua Driver tools

`tools_search` shows only the driver tools actually advertised by the embedded runtime and
allowed by the host. Their input schemas follow the driver rather than a local translated
action format, with host-owned permission/session fields narrowed below. The reviewed native names include `list_apps`, `list_windows`,
`get_window_state`, `get_accessibility_tree`, `get_screen_size`, `get_desktop_state`,
`get_cursor_position`, `get_agent_cursor_state`, `check_permissions`, `verify_state`, `launch_app`,
`set_window_frame`, `click`, `double_click`, `right_click`, `drag`,
`type_text`, `press_key`, `hotkey`, `set_value`, `scroll`, `clipboard_read` and
`clipboard_write`. Unsupported or undiscovered tools are absent; there is no synthetic
replacement schema.
Desktop omits `invoke_menu`: the driver brings its target to the foreground. It also omits
`zoom`: this driver's schema cannot carry the calling chat's screenshot session into the crop.
Both remain in Core's separate managed gateway; Desktop does not borrow that gateway's
implicit transport session or weaken its per-chat snapshot fence.

`get_agent_cursor_state({})` reads only the current chat's agent cursor, not the user's mouse
position. The host supplies its exact session; the upstream required `session` field is
advertised as optional with host-owned guidance, and caller-supplied values remain refused.
Core's managed gateway supplies its separately owned work session. This is a screen-permission
read available in Desktop Read-only mode; it does not consume or replace an input observation.
Cursor configuration, theming and session administration remain unavailable.
The optional mixed-license Perception extension is not bundled or exposed. Upgrading
the MIT driver does not install its detector/OCR models or grant extension administration.

Every native call uses the exact caller’s identity and current screen/control/clipboard
permissions. Read-only mode can retain observations and clipboard reads while preventing
state-changing input and clipboard writes. Snapshot-bound input must use an observation
belonging to that caller; one work cannot spend another work’s desktop state. Driver replies
retain the MCP envelope and are bounded before reaching code mode.
Element actions use the current observation's `element_token`, not `element_index` or
`snapshot_id` arguments. A token can supply its observed window identity; an explicit target
must still agree. Pixel `click` also names that observation's immutable `capture_id`.
Screenshot-only window observations may omit `snapshot_id`: a delivered image plus its
nonempty `capture_id` establishes pixel authority for the same exact owner and window.
It grants no element-token authority; token input still needs a snapshot and tree.
An image without a capture, or a capture without an image, cannot establish this path.
Other pixel and keyboard actions use the same host-owned session's fresh exact-window observation,
without adding fields absent from the driver's schema. Input reserves its observation before
dispatch, including uncertain outcomes; another input requires a new observation.
New reads retire previous action references. `verify_state` neither refreshes nor retargets
an existing observation's input authority. Missing/invalid screenshot evidence permits no
pixel action. Desktop captures report whether the driver's overlay was excluded through
`agent_overlay_capture`; an unavailable exclusion is reported, not silently claimed.
Desktop launch uses `name` or `bundle_id`; Windows `path`, `launch_path` and `aumid`
selectors are refused because they can supersede the checked name or carry arguments.
Revoked read results are withheld, not delivered with a warning. A mutation whose authority
changes after dispatch reports an uncertain effect without exposing its result.

## Permission and discovery invariants

- A tool call is checked against current permissions even if its schema was exposed earlier.
- Core, Desktop and Plugins do not forward or alias each other's tools.
- A connector token for one surface does not authorize the other surfaces.
- `work` actions and metadata-only `tools_search` skip browser identity by design; managed coding calls still require it.
- Read-only mode removes effective file-write, command, control and clipboard-write permissions
  without pretending the underlying configuration was changed.
- Approved filesystem roots do not sandbox command execution, external MCP servers or desktop control.
- Tool results and validation errors are bounded; large structured or binary payloads must not
  grow without an explicit cap.

## Compatibility notes

Older conversations can retain a cached MCP schema after a rebuild. Refresh/review the app in
ChatGPT, or recreate it if your workspace requires that, then start a new conversation when the
connector's exposed tool shape changes. The current extension pairs automatically with the local
bridge; there is no pairing code to enter.

## Tests that protect the surface

The MCP suites check exact surface membership, cross-surface rejection, discovery-size budgets,
permission gating, retired names and schema shape, and the work-control and external-gateway
contracts have their own suites. Native image parity has additional coverage.

When changing the public tool surface, update the implementation, the surface declarations,
the tests and this document together. Do not add a permanently exposed tool for a workflow
that can be expressed safely through the existing primitives.
