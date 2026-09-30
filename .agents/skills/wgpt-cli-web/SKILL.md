---
name: wgpt-cli-web
description: Use the wgpt CLI to start and manage durable, real ChatGPT Web work through the connected host, inspect exact work and page receipts, and avoid duplicate browser sends.
---

# Manage ChatGPT Web work with `wgpt`

Use this skill when an authorized user wants a coding task run or steered through the app's managed ChatGPT Web conversation from a terminal. `wgpt` is a local control client, not a general browser agent or an alternate model. It cannot arbitrarily browse sites, read a page's DOM, or prove the visible browser UI by itself. For page contents or visual verification, use a separately authorized browser-observation surface; do not infer DOM or provider completion from CLI admission alone.

## Preconditions and identity

- Run the bundled `wgpt` executable (`bin/wgpt` or the package `bin/wgpt.mjs` in a source checkout). Deliberately start the persistent Electron backend with `wgpt host start`; `wgpt host status` only observes it. Work commands never start the host. The host can run without an open GUI window, but managed browser delivery needs a connected connector and companion extension, a paired signed-in ChatGPT browser, the right account/model, and the app's existing permissions/setup. Check those separately; a running PID or open control socket is not a connected ChatGPT page.
- Use the same absolute `--data-dir` on every command if the host was started with a nondefault data directory. Do not mix the host's ledger with another profile. The standalone Node daemon has separate `wgpt daemon start|status|stop --data-dir <absolute-path>` commands and **requires** an explicit data directory. It has no GUI; browser transport is opt-in with `wgpt daemon start --browser --data-dir <absolute-path>`, and without a delivery path work admission is not web execution. Do not start a daemon in the GUI's active data directory or assume daemon status proves extension connection. There is no public `wgpt host stop` command.
- Work belongs to an existing absolute Git project path; local work IDs, agent IDs, session IDs, and ChatGPT conversation IDs are different. Copy exact IDs from receipts/status, never substitute a current selection, branch name or guessed conversation. The optional `--conversation-id` on connection/reconnect is an expected-ID fence, not a rebinding target.
- `--json` prints machine-readable stdout; diagnostics go to stderr. Exit 0 means the request succeeded/was accepted, **not** that ChatGPT saw or completed it; exit 2 is invalid input, 3 is host unavailable, 4 is rejected. A `connection`/`reconnect` result is successful only when `state` is `ready`; `opening`, `closed`, and `unavailable` are not ready.

## Run and observe

Replace bracketed placeholders with real values; keep one data directory consistently (the examples show `--data-dir` explicitly). Generate one UUID per *new* mutation and retain it with its exact payload before issuing the command. If the CLI times out or loses a reply, retry the **identical** command with the **same** `--request-id`, or inspect status/events first. Never generate a new request ID to repeat an ambiguous start/instruction/send. Reusing an ID with a different payload yields `REQUEST_ID_CONFLICT`.

```sh
wgpt host start --data-dir /absolute/data-dir --json
wgpt host status --data-dir /absolute/data-dir --json
wgpt work list --data-dir /absolute/data-dir --json
wgpt work start --project /absolute/git/repo --goal "Implement the requested change" --request-id <uuid> --data-dir /absolute/data-dir --json
wgpt work status <work_id> --data-dir /absolute/data-dir --json
wgpt work events <work_id> --after 0 --data-dir /absolute/data-dir --json
wgpt work connection <work_id> --data-dir /absolute/data-dir --json
```

Record the returned `work_id` from the start receipt. List pagination uses `next_cursor` with `wgpt work list --cursor <work_id>`.

`work events --json` emits one event per line (NDJSON), not a page object: it exposes `sequence`, never `next_cursor` or `has_more`. Without `--follow`, each invocation reads only one page (50 events by default; `--limit` accepts up to 200). To read all currently available history:

1. Start with `--after 0`, or the last successfully processed event's `sequence` when resuming.
2. Process every event in the successful response, then save the last event's `sequence` and pass it to the next `wgpt work events <work_id> --after <sequence> --data-dir /absolute/data-dir --json` call.
3. Repeat until a successful call emits no events. Keep the cursor unchanged for an empty response or an error; an error is not proof that history is exhausted. Do not treat a short page or exit 0 alone as the end of history.

`wgpt work events <work_id> --after <sequence> --follow --data-dir /absolute/data-dir --json` continues paging and streams new events; save each processed event's `sequence` to resume later. Ctrl-C stops the reader, not the work. `wgpt work reconnect <work_id> --agent-id <agent_uuid> --conversation-id <expected_conversation_id> --timeout 30000 --data-dir /absolute/data-dir --json` may attempt to restore an existing exact page; omit selectors to target the current prime. Reconnect does **not** resume a paused work or create a new conversation. The reconnect timeout is milliseconds; an events-follow timeout, if supplied, is seconds.

Only after confirming the exact work and intended change, steer it with a fresh UUID for each distinct action:

```sh
wgpt work instruct <work_id> --text "Also verify the changed behavior" --request-id <uuid> --data-dir /absolute/data-dir --json
wgpt work pause <work_id> --request-id <uuid> --data-dir /absolute/data-dir --json
wgpt work resume <work_id> --request-id <uuid> --data-dir /absolute/data-dir --json
wgpt work cancel <work_id> --request-id <uuid> --data-dir /absolute/data-dir --json
```

Pause/cancel can first record `desired_state` while draining before the factual `status` changes; poll status/events for the transition. `cancel` is not a browser-tab close or deletion of the ledger. If a work has a recorded `successor_work_id`, follow the exact successor rather than steering the completed predecessor. Use a fresh request ID for a genuinely different instruction or control action, and the original ID for an identical retry.

## Interpret receipts conservatively

- A start/instruct/control receipt (`request_id`, `work_id`, `status`, `revision`) proves local durable admission, not remote send, provider acceptance or task completion. Preserve the receipt and exact ID. Check `work status` for factual lifecycle, `desired_state`, blocker, agents, their bound `session_id`/`conversation_id`, pending command `request_id` and `delivery_state`, and recent operations/checkpoint. Status is bounded; consult events for the history.
- `pending`, `delivering`, `queued`, and `unknown` are **not** delivered. `queued` may mean the outbox holds the instruction; `unknown` means handoff is ambiguous. `failed`/`cancelled` are not successful sends. A `delivered` receipt is stronger delivery evidence, but not a completed ChatGPT turn. Do not manually paste or resend the same text to the browser to “help” an ambiguous command; let the exact outbox row reconcile, inspect its events/status, and report uncertainty if it remains unresolved. An instruction event such as `instruction_queued` is not `instruction_delivered`.
- `work connection` reports the current authenticated page state for an exact work/agent/conversation. `ready` with `page_observed_at` is current page evidence, not a claim that a specific instruction was sent or that the model finished. `page_observed_at` is process-local; null means no sighting since this host started. `closed`/`opening`/`unavailable` and a reason are explicit limits. A model slug accepted as an option is not proof of account entitlement; inspect blockers such as `AUTH_REQUIRED`, `PROVIDER_UNAVAILABLE` or `MODEL_UNAVAILABLE` rather than assuming progress.
- Correlate work events, delivery state, agent operation results, blocker, and host-generated checkpoint verification by their exact IDs. `completed` in the work ledger is a stronger lifecycle fact than `running`, but report only the checked outcomes and cite actual operation/checkpoint receipts; do not equate a model-written summary, a terminal exit, or an open page with proof of an external website's content. If the request requires browser-page verification, perform separate authorized observation of that exact conversation/document and report its evidence and limits.
