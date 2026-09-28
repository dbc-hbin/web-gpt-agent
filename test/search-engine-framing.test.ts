/**
 * Engine stream framing and exit-2 verdicts.
 *
 * The child process is a controlled pipe here rather than the bundled engine: a pipe boundary
 * landing inside a multibyte character is a property of the framing, not of ripgrep, and only a
 * writer that splits a record exactly there can reproduce it on every platform. The bytes on
 * either side are the bytes ripgrep emits — a `--null` listing record, a `--json` match event and
 * real stderr — so the parser, the sink and the error mapping under test are the production ones.
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

type CloseListener = (code: number | null) => void;

interface EngineChild {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  kill(): void;
  once(event: 'close' | 'error', listener: CloseListener): EngineChild;
  /** Ends both pipes, waits for the reader to drain them, then reports the exit code. */
  finish(code: number | null): Promise<void>;
}

/** Handed to `spawn`; only ever called while a test is driving one run. */
const engine = vi.hoisted(() => ({ makeChild: null as (() => EngineChild) | null }));

vi.mock('node:child_process', () => ({ spawn: () => engine.makeChild?.() }));
// The engine is a pipe in this test, so where the real binary lives is irrelevant — and mocking
// the lookup keeps the test runnable on a checkout that has not fetched ripgrep yet.
vi.mock('../src/main/ripgrep.js', () => ({ locateRipgrep: () => '/opt/ripgrep/rg' }));

import {
  SearchEngineFailureError,
  SearchPatternError,
  search,
  searchStream,
  type SearchStreamHit,
  type SearchStreamRequest
} from '../src/main/search.js';

/** The bytes ripgrep writes for one `--json` match event. */
function matchEvent(relPath: string, text: string): string {
  return `${JSON.stringify({
    type: 'match',
    data: {
      path: { text: relPath },
      lines: { text: `${text}\n` },
      line_number: 1,
      absolute_offset: 0,
      submatches: [{ match: { text: 'findme' }, start: 0, end: 6 }]
    }
  })}\n`;
}

/** Cuts a payload exactly where a pipe would: inside a multibyte character. */
function splitMidCharacter(payload: string): [Buffer, Buffer] {
  const bytes = Buffer.from(payload, 'utf8');
  const lead = bytes.findIndex((byte) => (byte & 0xc0) === 0xc0);
  if (lead === -1) throw new Error('the payload has no multibyte character to split');
  return [bytes.subarray(0, lead + 1), bytes.subarray(lead + 1)];
}

function streamRequest(overrides: Partial<SearchStreamRequest> = {}): SearchStreamRequest {
  return {
    realDir: process.cwd(),
    virtualDir: '/root',
    query: '',
    mode: 'name',
    exclude: [],
    caseSensitive: false,
    ...overrides
  };
}

const spawned: EngineChild[] = [];

engine.makeChild = (): EngineChild => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners: CloseListener[] = [];
  const child: EngineChild = {
    stdout,
    stderr,
    kill: () => undefined,
    once: (event, listener) => {
      if (event === 'close') listeners.push(listener);
      return child;
    },
    finish: async (code) => {
      stdout.end();
      stderr.end();
      // 'end' arrives only after the reader has seen every chunk, so the close event that settles
      // the run cannot overtake the data handlers the fix has to be exercised through.
      await Promise.all([drained(stdout), drained(stderr)]);
      for (const listener of listeners) listener(code);
    }
  };
  spawned.push(child);
  return child;
};

function drained(stream: PassThrough): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  stream.once('end', () => resolve());
  return promise;
}

function lastChild(): EngineChild {
  const child = spawned.at(-1);
  if (!child) throw new Error('the search did not start an engine child');
  return child;
}

/** Capture the thrown engine error after the controlled child exits. */
async function failureOf(run: Promise<unknown>): Promise<Error> {
  const failure = await run.then(
    () => null,
    (error: unknown) => error
  );
  if (!(failure instanceof Error)) throw new Error('the run was expected to fail');
  return failure;
}

describe('engine stream framing', () => {
  it('keeps a filename whole when the pipe splits a multibyte character', async () => {
    const hits: SearchStreamHit[] = [];
    const run = searchStream(streamRequest(), { onHit: (hit) => hits.push(hit) });
    const child = lastChild();
    const [head, tail] = splitMidCharacter('한글 노트.md\0');
    child.stdout.write(head);
    child.stdout.write(tail);
    await child.finish(0);

    const outcome = await run;
    expect(outcome.stoppedBecause).toBeNull();
    expect(hits.map((hit) => hit.path)).toEqual(['/root/한글 노트.md']);
  });

  it('keeps a streamed match path and line whole across a split', async () => {
    const hits: SearchStreamHit[] = [];
    const run = searchStream(streamRequest({ mode: 'content', query: 'findme' }), {
      onHit: (hit) => hits.push(hit)
    });
    const child = lastChild();
    const [head, tail] = splitMidCharacter(matchEvent('./한글 노트.md', 'findme 한글과 이모지 🎉 ünïcode'));
    child.stdout.write(head);
    child.stdout.write(tail);
    await child.finish(0);
    await run;

    expect(hits).toEqual([
      { path: '/root/한글 노트.md', line: 1, text: 'findme 한글과 이모지 🎉 ünïcode' }
    ]);
  });

  it('keeps a buffered match path and line whole across a split', async () => {
    const run = search({
      realDir: process.cwd(),
      virtualDir: '/root',
      query: 'findme',
      mode: 'content',
      exclude: [],
      caseSensitive: false,
      maxResults: 10
    });
    const child = lastChild();
    const [head, tail] = splitMidCharacter(matchEvent('./한글 노트.md', 'findme 한글과 이모지 🎉 ünïcode'));
    child.stdout.write(head);
    child.stdout.write(tail);
    await child.finish(0);

    const outcome = await run;
    expect(outcome.hits).toEqual([
      { path: '/root/한글 노트.md', line: 1, text: 'findme 한글과 이모지 🎉 ünïcode' }
    ]);
  });

  it('keeps a glob diagnostic whole when stderr is split', async () => {
    const run = searchStream(streamRequest({ include: '**/*.md' }), { onHit: () => undefined });
    const child = lastChild();
    const [head, tail] = splitMidCharacter(
      "rg: error parsing glob '한글[': unclosed character class; missing ']'\n"
    );
    child.stderr.write(head);
    child.stderr.write(tail);
    await child.finish(2);

    const failure = await failureOf(run);
    expect(failure).toBeInstanceOf(SearchPatternError);
    expect(failure.message).toContain('한글[');
    expect(failure.message).not.toContain('�');
  });

  it('reports a rejected regex by its reason', async () => {
    const run = searchStream(streamRequest({ mode: 'content', query: 'a(' }), { onHit: () => undefined });
    const child = lastChild();
    child.stderr.write('rg: regex parse error:\n    (?:a()\n    ^\nerror: unclosed group\n');
    await child.finish(2);

    const failure = await failureOf(run);
    expect(failure).toBeInstanceOf(SearchPatternError);
    expect(failure.message).toContain('unclosed group');
  });

  it('never publishes the native path of an IO failure in content search', async () => {
    const run = searchStream(streamRequest({ mode: 'content', query: 'findme' }), {
      onHit: () => undefined
    });
    const child = lastChild();
    child.stderr.write(
      'rg: /private/var/folders/secret-approved-root/notes.md: Permission denied (os error 13)\n'
    );
    await child.finish(2);

    const failure = await failureOf(run);
    expect(failure).toBeInstanceOf(SearchEngineFailureError);
    expect(failure.message).not.toContain('secret-approved-root');
  });

  it('never publishes the native path of an IO failure in name listing', async () => {
    const run = searchStream(streamRequest(), { onHit: () => undefined });
    const child = lastChild();
    child.stderr.write('rg: ./secret-approved-root: Permission denied (os error 13)\n');
    await child.finish(2);

    const failure = await failureOf(run);
    expect(failure).toBeInstanceOf(SearchEngineFailureError);
    expect(failure.message).not.toContain('secret-approved-root');
  });
});
