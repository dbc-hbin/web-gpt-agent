/**
 * Bounded, retained search over the real bundled ripgrep.
 *
 * These tests exercise the managed path end to end against real files and the real engine:
 * a real fixture tree (Unicode and spaces in names, nested folders, an ignored dependency
 * folder, a very long line), real page retention through the session asset store, and a real
 * paging walk that has to neither skip nor duplicate a hit when the caller changes
 * `max_results` between requests.
 */

import { randomUUID } from 'node:crypto';
import * as searchModule from '../src/main/search.js';
import * as configModule from '../src/main/config.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SEARCH_PAGE_BYTES,
  SEARCH_PAGE_HITS,
  clipPreview,
  searchStream,
  type SearchStreamHit
} from '../src/main/search.js';
import {
  SearchPageError,
  managedSearch,
  readSearchPage,
  ordinarySearch,
  clearOrdinarySearchSnapshots,
  parseSearchCursor,
  type ManagedSearchPage,
  type ManagedSearchRequest,
  type SearchArtifactRecord,
  type SearchArtifactStore,
  type SearchOwner
} from '../src/main/search-pages.js';
import type { WorkArtifactRow } from '../src/main/work/store.js';
import type { CallContext } from '../src/main/mcp/call-context.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { createSession, initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

let root = '';
let fixture = '';

beforeAll(async () => {
  root = await makeTempDir('wgpt-search-store-');
  initSessionStore(root);
  fixture = await makeTempDir('wgpt-search-fixture-');
  await writeTree(fixture, {
    'README.md': 'findme at the top level\n',
    'src/index.ts': 'export const answer = 42;\nconsole.log(answer);\n',
    'src/deep/nested.ts': 'const NEEDLE = "findme";\n',
    'src/notes.md': '# Notes\nfindme in markdown\n',
    'deps/vendor/pkg/index.js': 'findme in a dependency\n',
    'odd dir with spaces/한글 노트.md': 'findme 한글과 이모지 🎉 ünïcode\n',
    'odd dir with spaces/plain.txt': 'nothing to see\n',
    'long.txt': `${'z'.repeat(5000)}findme\n`
  });
});

afterAll(async () => {
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  await removeTempDir(fixture);
  await removeTempDir(root);
});

/** A real artifact store: page text goes through the session asset store, rows are retained. */
function createArtifactStore(): SearchArtifactStore {
  const rows = new Map<string, WorkArtifactRow>();
  return {
    async recordArtifact(input: SearchArtifactRecord): Promise<WorkArtifactRow> {
      const { writeOverflowText } = await import('../src/main/session/store.js');
      const assetId = await writeOverflowText(input.sessionId, input.text);
      if (!assetId) throw new Error('page text was not retained');
      const row: WorkArtifactRow = {
        artifact_id: randomUUID(),
        work_id: input.workId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        asset_id: assetId,
        kind: input.kind,
        query_hash: input.queryHash,
        page_index: input.pageIndex,
        page_count: input.pageCount,
        hit_count: input.hitCount,
        total_hits: input.totalHits,
        truncated_reason: input.truncatedReason,
        byte_size: Buffer.byteLength(input.text, 'utf8'),
        created_at: Date.now()
      };
      rows.set(row.artifact_id, row);
      return row;
    },
    async getArtifact(cursor: string): Promise<WorkArtifactRow | null> {
      return rows.get(cursor) ?? null;
    },
    async listArtifacts(input: { workId: string; kind?: string; queryHash?: string }): Promise<WorkArtifactRow[]> {
      return [...rows.values()]
        .filter((row) => row.work_id === input.workId)
        .filter((row) => input.kind === undefined || row.kind === input.kind)
        .filter((row) => input.queryHash === undefined || row.query_hash === input.queryHash)
        .sort((a, b) => a.page_index - b.page_index);
    }
  };
}

async function owner(): Promise<SearchOwner> {
  const session = await createSession({ title: 'Search fixture' });
  return { workId: randomUUID(), agentId: randomUUID(), sessionId: session.id };
}

/**
 * The shared fixture request.
 *
 * `managedSearch` and `searchStream` take the same core fields, and the streaming entry point
 * adds its own retained-hit ceiling, so one builder serves both. The fields the builder always
 * fills are required here rather than optional, which is what lets either signature accept it
 * without a cast at each call site.
 */
type FixtureRequest = Omit<ManagedSearchRequest, 'exclude' | 'mode' | 'caseSensitive'> & {
  exclude: readonly string[];
  mode: 'name' | 'content';
  caseSensitive: boolean;
  maxHits?: number;
};

function baseRequest(overrides: Partial<FixtureRequest> = {}): FixtureRequest {
  return {
    realDir: fixture,
    virtualDir: '/root',
    query: 'findme',
    mode: 'content',
    exclude: [],
    caseSensitive: false,
    maxResults: 50,
    ...overrides
  };
}

/** Walks every retained page of a run through cursors, returning the hits in order. */
async function walkPages(
  store: SearchArtifactStore,
  who: SearchOwner,
  first: ManagedSearchPage,
  pageSize: number
): Promise<SearchStreamHit[]> {
  const hits: SearchStreamHit[] = [...first.hits];
  let cursor = first.next_cursor;
  let guard = 0;
  while (cursor !== null) {
    if (++guard > 500) throw new Error('paging did not terminate');
    const page = await readSearchPage({ artifacts: store }, who, cursor, pageSize);
    hits.push(...page.hits);
    cursor = page.next_cursor;
  }
  return hits;
}

describe('searchStream over the real engine', () => {
  it('streams content hits with real paths and line numbers, including Unicode and spaces', async () => {
    const hits: SearchStreamHit[] = [];
    const outcome = await searchStream(baseRequest({ exclude: [] }), { onHit: (hit) => hits.push(hit) });
    const byPath = new Map(hits.map((hit) => [hit.path, hit]));
    expect(outcome.hits).toEqual([]);
    expect(byPath.get('/root/README.md')).toMatchObject({ line: 1, text: 'findme at the top level' });
    expect(byPath.get('/root/src/deep/nested.ts')).toMatchObject({ line: 1 });
    const unicode = byPath.get('/root/odd dir with spaces/한글 노트.md');
    expect(unicode?.text).toBe('findme 한글과 이모지 🎉 ünïcode');
    expect(hits.every((hit) => hit.path.startsWith('/root/'))).toBe(true);
  });

  it('honours the default exclusions but still searches an explicitly included root', async () => {
    const excluded: SearchStreamHit[] = [];
    await searchStream(
      baseRequest({ exclude: ['node_modules', 'deps'] }),
      { onHit: (hit) => excluded.push(hit) }
    );
    expect(excluded.map((hit) => hit.path)).not.toContain('/root/deps/vendor/pkg/index.js');

    const included: SearchStreamHit[] = [];
    await searchStream(
      baseRequest({ realDir: path.join(fixture, 'deps'), virtualDir: '/root/deps', exclude: ['deps'] }),
      { onHit: (hit) => included.push(hit) }
    );
    expect(included.map((hit) => hit.path)).toContain('/root/deps/vendor/pkg/index.js');
  });

  it('treats a missing pattern as an empty success, not an error', async () => {
    const hits: SearchStreamHit[] = [];
    const outcome = await searchStream(
      baseRequest({ query: 'no-such-token-anywhere' }),
      { onHit: (hit) => hits.push(hit) }
    );
    expect(hits).toEqual([]);
    expect(outcome.truncated).toBe(false);
    expect(outcome.stoppedBecause).toBeNull();
  });

  it('reports an invalid regex as a pattern error, not an empty result', async () => {
    await expect(
      searchStream(baseRequest({ query: 'a(', regex: true }), { onHit: () => undefined })
    ).rejects.toThrow(/Invalid search pattern/);
  });

  it('clips a long line at 512 code points and says so', async () => {
    const hits: SearchStreamHit[] = [];
    await searchStream(
      baseRequest({ realDir: path.join(fixture, 'long.txt'), virtualDir: '/root/long.txt', targetIsFile: true }),
      { onHit: (hit) => hits.push(hit) }
    );
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.clipped).toBe(true);
    expect(Array.from(hit.text ?? '').length).toBeLessThanOrEqual(513);
    expect(hit.text?.endsWith('…')).toBe(true);
    expect(hit.line_chars).toBe(5006);
    expect(hit.line).toBe(1);
  });

  it('streams file names for name mode and applies the include filter', async () => {
    const names: SearchStreamHit[] = [];
    await searchStream(
      baseRequest({ mode: 'name', query: 'notes', include: '**/*.md', exclude: [] }),
      { onHit: (hit) => names.push(hit) }
    );
    expect(names.map((hit) => hit.path)).toEqual(['/root/src/notes.md']);
  });

  it('stops at the retained-hit ceiling and reports why', async () => {
    const hits: SearchStreamHit[] = [];
    const outcome = await searchStream(
      baseRequest({ maxHits: 2 }),
      { onHit: (hit) => hits.push(hit) }
    );
    expect(hits).toHaveLength(2);
    expect(outcome.truncated).toBe(true);
    expect(outcome.stoppedBecause).toBe('hits');
  });
});

describe('clipPreview', () => {
  it('never splits an astral character', () => {
    const line = '🎉'.repeat(600);
    const clipped = clipPreview(line, 512, true);
    expect(clipped.clipped).toBe(true);
    expect(Array.from(clipped.text.replace('…', ''))).toHaveLength(512);
    expect(clipped.chars).toBe(600);
    expect(clipped.text.includes('\uFFFD')).toBe(false);
  });
});

describe('retained paging', () => {
  it('walks a run through cursors without skipping or duplicating, even when the page size changes', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const flood = await makeTempDir('wgpt-search-flood-');
    try {
      const lines = Array.from({ length: 1200 }, (_, i) => `needle ${i}`).join('\n');
      await writeTree(flood, { 'a.txt': `${lines}\n`, 'b.txt': `${lines}\n` });
      const first = await managedSearch(
        { artifacts: store },
        who,
        baseRequest({ realDir: flood, query: 'needle', maxResults: 7 })
      );
      expect(first.hits).toHaveLength(7);
      expect(first.next_cursor).not.toBeNull();
      expect(first.page.total_hits).toBe(2400);

      const walked = await walkPages(store, who, first, 13);
      expect(walked).toHaveLength(2400);
      const keys = walked.map((hit) => `${hit.path}:${hit.line}:${hit.text}`);
      expect(new Set(keys).size).toBe(2400);
    } finally {
      await removeTempDir(flood);
    }
  });

  it('retains every page of a run separately, each within the page budget', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const flood = await makeTempDir('wgpt-search-pages-');
    try {
      const lines = Array.from({ length: 2000 }, (_, i) => `needle ${i}`).join('\n');
      await writeTree(flood, { 'a.txt': `${lines}\n` });
      const first = await managedSearch({ artifacts: store }, who, baseRequest({ realDir: flood, query: 'needle', maxResults: 5 }));
      const rows = await store.listArtifacts({ workId: who.workId });
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((row) => row.byte_size <= SEARCH_PAGE_BYTES)).toBe(true);
      expect(rows.every((row) => row.hit_count <= SEARCH_PAGE_HITS)).toBe(true);
      expect(rows.map((row) => row.page_index)).toEqual(rows.map((_, index) => index));
      expect(rows.at(-1)?.truncated_reason).toBeNull();
      expect(first.page.count).toBe(rows.length);
    } finally {
      await removeTempDir(flood);
    }
  });

  it('fails with SEARCH_RESULT_TOO_LARGE instead of returning a record it cannot fit', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const tree = await makeTempDir('wgpt-search-oversize-');
    try {
      // A virtual path is caller-supplied text, so one record can be arbitrarily long without any
      // real filesystem path being long: a valid request whose escaped path alone exceeds the
      // whole page budget. Returning it would breach the bound; truncating it would hand back a
      // path that names nothing; omitting it would report fewer matches than exist.
      const virtualDir = `/root/${'🎉'.repeat(8_000)}`;
      await writeTree(tree, { 'hit.txt': 'needle\n' });
      const attempt = managedSearch(
        { artifacts: store },
        who,
        baseRequest({ realDir: tree, virtualDir, query: 'needle', maxResults: 50 })
      );
      await expect(attempt).rejects.toMatchObject({ code: 'SEARCH_RESULT_TOO_LARGE' });

      // The refusal itself must fit the response bound, so it quotes only a short preview of the
      // path that did not fit rather than reproducing it — serialized as the real MCP tool error.
      let refusal = '';
      try {
        await attempt;
      } catch (thrown) {
        refusal = thrown instanceof Error ? thrown.message : String(thrown);
      }
      const envelope = JSON.stringify({ content: [{ type: 'text', text: refusal }], isError: true });
      expect(Buffer.byteLength(envelope, 'utf8')).toBeLessThan(SEARCH_PAGE_BYTES);
      expect(refusal.length).toBeLessThan(1_000);
      expect(refusal).not.toContain(virtualDir);
      expect(refusal).toContain('SEARCH_RESULT_TOO_LARGE');
      // Nothing was retained as a successful page.
      expect(await store.listArtifacts({ workId: who.workId })).toEqual([]);
    } finally {
      await removeTempDir(tree);
    }
  });

  it('answers a page from the retained snapshot rather than re-running the query', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const tree = await makeTempDir('wgpt-search-snapshot-');
    try {
      await writeTree(tree, { 'a.txt': 'needle one\nneedle two\n' });
      const first = await managedSearch({ artifacts: store }, who, baseRequest({ realDir: tree, query: 'needle', maxResults: 1 }));
      expect(first.next_cursor).not.toBeNull();
      await fs.rm(path.join(tree, 'a.txt'));
      const second = await readSearchPage({ artifacts: store }, who, first.next_cursor!, 1);
      expect(second.hits.map((hit) => hit.text)).toEqual(['needle two']);
    } finally {
      await removeTempDir(tree);
    }
  });

  it('rejects a cursor from another work or worker and an unknown cursor', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const first = await managedSearch({ artifacts: store }, who, baseRequest({ maxResults: 1 }));
    const cursor = first.next_cursor ?? (await managedSearch({ artifacts: store }, who, baseRequest({ realDir: path.join(fixture, 'src'), maxResults: 1 }))).next_cursor;
    expect(cursor).not.toBeNull();

    const stranger = await owner();
    await expect(readSearchPage({ artifacts: store }, stranger, cursor!, 1)).rejects.toMatchObject({ code: 'SEARCH_CURSOR_INVALID' });
    await expect(readSearchPage({ artifacts: store }, who, 'not-a-real-cursor', 1)).rejects.toMatchObject({ code: 'SEARCH_CURSOR_INVALID' });
    const unknown = `${randomUUID()}:0`;
    await expect(readSearchPage({ artifacts: store }, who, unknown, 1)).rejects.toMatchObject({ code: 'SEARCH_CURSOR_INVALID' });
  });

  it('reports an expired cursor when the retained page text is gone', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const first = await managedSearch({ artifacts: store }, who, baseRequest({ maxResults: 1 }));
    expect(first.next_cursor).not.toBeNull();
    const [artifactId] = first.next_cursor!.split(':');
    const row = await store.getArtifact(artifactId!);
    expect(row).not.toBeNull();
    await fs.rm(path.join(root, 'sessions', row!.session_id, 'assets', row!.asset_id), { force: true });
    await expect(readSearchPage({ artifacts: store }, who, first.next_cursor!, 1)).rejects.toMatchObject({
      code: 'SEARCH_CURSOR_EXPIRED'
    });
  });

  it('keeps a cursor valid across a conversation rebind because ownership is the stable session', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const first = await managedSearch({ artifacts: store }, who, baseRequest({ maxResults: 1 }));
    expect(first.next_cursor).not.toBeNull();
    const { rebindSession } = await import('../src/main/session/store.js');
    await rebindSession(who.sessionId, null, randomUUID());
    const page = await readSearchPage({ artifacts: store }, who, first.next_cursor!, 1);
    expect(page.hits).toHaveLength(1);
    expect(page.page.total_hits).toBeGreaterThan(1);
  });

  it('reads deployed headerless pages with unknown metrics and refuses damaged retained hits', async () => {
    const who = await owner();
    const legacy = createArtifactStore();
    const record = legacy.recordArtifact.bind(legacy);
    legacy.recordArtifact = input => record({ ...input, text: input.text.slice(input.text.indexOf('\n') + 1) });
    const first = await managedSearch({ artifacts: legacy }, who,
      baseRequest({ realDir: path.join(fixture, 'src'), maxResults: 1 }));
    const next = await readSearchPage({ artifacts: legacy }, who, first.next_cursor!, 1);
    expect(next.elapsed_ms).toBeNull();
    expect(next.files_scanned).toBeNull();

    const damaged = createArtifactStore();
    const persist = damaged.recordArtifact.bind(damaged);
    damaged.recordArtifact = input => persist({ ...input, text: input.text.replace(/\n\{[^\n]+/, '\nnot-json') });
    const corrupt = await managedSearch({ artifacts: damaged }, who,
      baseRequest({ realDir: path.join(fixture, 'src'), maxResults: 1 }));
    await expect(readSearchPage({ artifacts: damaged }, who, corrupt.next_cursor!, 1)).rejects.toThrow(/SEARCH_CURSOR_CORRUPT/);
  });

  it('says no cursor when the run fits in one page', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const first = await managedSearch(
      { artifacts: store },
      who,
      baseRequest({ realDir: path.join(fixture, 'src'), maxResults: 50 })
    );
    expect(first.hits.length).toBeGreaterThan(0);
    expect(first.next_cursor).toBeNull();
    expect(first.truncated).toBeNull();
    expect(first.engine).toBe('ripgrep');
  });

  it('returns an explicit empty success with no cursor when nothing matched', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const page = await managedSearch(
      { artifacts: store },
      who,
      baseRequest({ query: 'no-such-token-anywhere', maxResults: 50 })
    );
    expect(page.hits).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(page.truncated).toBeNull();
    expect(page.stopped_because).toBeNull();
  });

  it('surfaces the engine pattern error as a coded failure', async () => {
    const store = createArtifactStore();
    const who = await owner();
    await expect(
      managedSearch({ artifacts: store }, who, baseRequest({ query: 'a(', regex: true }))
    ).rejects.toThrow(/Invalid search pattern/);
  });

  it('refuses a worker with no stable session before running anything', async () => {
    const store = createArtifactStore();
    const who = await owner();
    await expect(
      managedSearch({ artifacts: store }, { ...who, sessionId: '' }, baseRequest())
    ).rejects.toBeInstanceOf(SearchPageError);
  });
});

describe('ordinary retained search', () => {
  afterAll(() => clearOrdinarySearchSnapshots());

  it('pages an explicit native scope only until all-files authority is revoked', async () => {
    const config = { ...configModule.getConfig(), fileAccessMode: 'all-files' as const };
    const live = vi.spyOn(configModule, 'getConfig').mockImplementation(() => config);
    try {
      const file = path.join(fixture, 'revocation.txt');
      await fs.writeFile(file, 'needle\n'.repeat(70));
      const first = await ordinarySearch([], null, { query: 'needle', mode: 'content', path: file, max_results: 1 });
      expect(first.next_cursor).not.toBeNull();
      expect((await ordinarySearch([], null, { cursor: first.next_cursor! })).hits).toHaveLength(50);
      live.mockReturnValue({ ...config, fileAccessMode: 'approved-roots' });
      await expect(ordinarySearch([], null, { cursor: first.next_cursor! }))
        .rejects.toMatchObject({ code: 'SEARCH_CURSOR_INVALID' });
      await expect(ordinarySearch([], null, { query: 'needle', path: file })).rejects.toThrow();
    } finally { live.mockRestore(); clearOrdinarySearchSnapshots(); }
  });

  it('rejects an unscoped query but keeps a scoped zero-hit search successful', async () => {
    await expect(ordinarySearch([], null, { query: 'needle' })).rejects.toMatchObject({ code: 'SEARCH_SCOPE_REQUIRED' });
    const scoped = await ordinarySearch([{ name: 'project', path: fixture }], null,
      { query: 'no-such-name-anywhere', mode: 'name' });
    expect(scoped).toMatchObject({ hits: [], next_cursor: null, truncated: null, stopped_because: null });
  });

  it('shares one deadline across roots and never claims an unsearched later root succeeded', async () => {
    const a = await makeTempDir('wgpt-deadline-a-');
    const b = await makeTempDir('wgpt-deadline-b-');
    const roots = [{ name: 'a', path: a }, { name: 'b', path: b }];
    try {
      await Promise.all([fs.writeFile(path.join(a, 'needle-a'), ''), fs.writeFile(path.join(b, 'needle-b'), '')]);
      // The real first stream completes before the shared clock reaches the deadline.
      // Its completion, not an incidental number of Date.now calls, advances time.
      vi.useFakeTimers({ toFake: ['Date'] });
      const initial = Date.now();
      const realStream = searchModule.searchStream;
      const stream = vi.spyOn(searchModule, 'searchStream').mockImplementation(async (req, sink) => {
        const outcome = await realStream(req, sink);
        vi.setSystemTime(initial + 10_000);
        return outcome;
      });
      try {
        const expired = await ordinarySearch(roots, null, { query: 'needle', mode: 'name' });
        expect(expired.hits.map(hit => hit.path)).toEqual(['/a/needle-a']);
        expect(expired.stopped_because).toBe('time');
        expect(expired.truncated).toBe('scan');
        expect(expired.files_scanned).toBe(1);
        expect(stream).toHaveBeenCalledTimes(1);
      } finally { stream.mockRestore(); vi.useRealTimers(); }
      const complete = await ordinarySearch(roots, null, { query: 'needle', mode: 'name' });
      expect(complete.hits.map(hit => hit.path).sort()).toEqual(['/a/needle-a', '/b/needle-b']);
      expect(complete.stopped_because).toBeNull();
    } finally { clearOrdinarySearchSnapshots(); await Promise.all([a, b].map(removeTempDir)); }
  });

  it('classifies ordinary and deployed managed cursors without accepting malformed offsets', () => {
    const id = randomUUID();
    expect(parseSearchCursor(`${id}.2:3`)).toEqual({ artifactId: `${id}.2`, offset: 3, storage: 'ordinary' });
    expect(parseSearchCursor(`${id}:3`)).toEqual({ artifactId: id, offset: 3, storage: 'managed' });
    expect(parseSearchCursor(`${id}.2:-1`)).toBeNull();
    expect(parseSearchCursor(`${id}.2:NaN`)).toBeNull();
    expect(parseSearchCursor(`${id}.2:9007199254740992`)).toBeNull();
  });

  it('pages an explicit 70-line file as an immutable snapshot with truthful metrics', async () => {
    const tree = await makeTempDir('wgpt-ordinary-file-');
    const roots = [{ name: 'project', path: tree }];
    try {
      const file = path.join(tree, 'lines.txt');
      await fs.writeFile(file, Array.from({ length: 70 }, (_, i) => 'needle ' + i).join('\n'));
      const first = await ordinarySearch(roots, null, { query: 'needle', mode: 'content', path: '/project/lines.txt', max_results: 50 });
      expect(first.hits).toHaveLength(50);
      expect(first.page.total_hits).toBe(70);
      await fs.unlink(file);
      const second = await ordinarySearch(roots, null, { cursor: first.next_cursor!, max_results: 50 });
      expect(second.hits.map(hit => hit.line)).toEqual(Array.from({ length: 20 }, (_, i) => i + 51));
      expect(second.next_cursor).toBeNull();
      expect(second.files_scanned).toBe(first.files_scanned);
      expect(second.elapsed_ms).toBe(first.elapsed_ms);
      expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(SEARCH_PAGE_BYTES);
    } finally { clearOrdinarySearchSnapshots(); await removeTempDir(tree); }
  });

  it('searches every approved root, clips Unicode, and denies revoked scope', async () => {
    const a = await makeTempDir('wgpt-ordinary-a-');
    const b = await makeTempDir('wgpt-ordinary-b-');
    const roots = [{ name: 'a', path: a }, { name: 'b', path: b }];
    try {
      await fs.writeFile(path.join(a, 'a.txt'), 'needle\n'.repeat(60));
      await fs.writeFile(path.join(b, 'b.txt'), 'needle ' + '🎉'.repeat(520) + '\n');
      const first = await ordinarySearch(roots, null, { query: 'needle', mode: 'content', max_results: 50 });
      let cursor = first.next_cursor;
      const hits = [...first.hits];
      while (cursor) { const page = await ordinarySearch(roots, null, { cursor }); hits.push(...page.hits); cursor = page.next_cursor; }
      expect(hits).toHaveLength(61);
      expect(hits.find(hit => hit.path === '/b/b.txt')).toMatchObject({ clipped: true, line_chars: 527 });
      await expect(ordinarySearch(roots.slice(0, 1), null, { cursor: first.next_cursor! })).rejects.toThrow();
    } finally { clearOrdinarySearchSnapshots(); await Promise.all([a, b].map(removeTempDir)); }
  });

  it('expires cursors lazily and rejects a symlink scope retarget', async () => {
    const tree = await makeTempDir('wgpt-ordinary-link-');
    const target = await makeTempDir('wgpt-ordinary-target-');
    const roots = [{ name: 'project', path: tree }, { name: 'target', path: target }];
    try {
      await fs.writeFile(path.join(tree, 'a.txt'), 'needle\n'.repeat(70));
      await fs.mkdir(path.join(target, 'first'));
      await fs.mkdir(path.join(target, 'second'));
      await fs.writeFile(path.join(target, 'first', 'b.txt'), 'needle\n'.repeat(70));
      await fs.symlink(path.join(target, 'first'), path.join(target, 'link'));
      const linked = await ordinarySearch(roots, null, { query: 'needle', mode: 'content', path: '/target/link', max_results: 1 });
      await fs.unlink(path.join(target, 'link'));
      await fs.symlink(path.join(target, 'second'), path.join(target, 'link'));
      await expect(ordinarySearch(roots, null, { cursor: linked.next_cursor! })).rejects.toThrow();
      const first = await ordinarySearch(roots, null, { query: 'needle', mode: 'content', path: '/project', max_results: 1 });
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 15 * 60_000);
        await expect(ordinarySearch(roots, null, { cursor: first.next_cursor! })).rejects.toThrow(/SEARCH_CURSOR_INVALID/);
      } finally { vi.useRealTimers(); }
    } finally { clearOrdinarySearchSnapshots(); await Promise.all([tree, target].map(removeTempDir)); }
  });

  it('bounds complete JSON pages of long Unicode hits without skipping any match', async () => {
    const tree = await makeTempDir('wgpt-ordinary-unicode-');
    const roots = [{ name: 'project', path: tree }];
    try {
      await fs.writeFile(path.join(tree, 'a.txt'), Array.from({ length: 100 }, (_, i) =>
        'needle ' + '🎉'.repeat(520) + ' ' + i).join('\n'));
      let page = await ordinarySearch(roots, null, { query: 'needle', mode: 'content', max_results: 500 });
      const lines: number[] = [];
      for (;;) {
        expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(SEARCH_PAGE_BYTES);
        for (const hit of page.hits) { expect(hit.clipped).toBe(true); lines.push(hit.line!); }
        if (!page.next_cursor) break;
        page = await ordinarySearch(roots, null, { cursor: page.next_cursor, max_results: 500 });
      }
      expect(lines).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    } finally { clearOrdinarySearchSnapshots(); await removeTempDir(tree); }
  });

  it('does not publish an in-flight snapshot across endpoint reset', async () => {
    const tree = await makeTempDir('wgpt-ordinary-epoch-');
    try {
      await fs.writeFile(path.join(tree, 'a.txt'), 'needle\n'.repeat(70));
      const pending = ordinarySearch([{ name: 'project', path: tree }], null,
        { query: 'needle', mode: 'content', max_results: 1 });
      clearOrdinarySearchSnapshots();
      await expect(pending).rejects.toThrow(/SEARCH_CURSOR_EXPIRED/);
    } finally { clearOrdinarySearchSnapshots(); await removeTempDir(tree); }
  });

  it('reports the retained hit ceiling as a scan stop while a cursor still pages', async () => {
    const tree = await makeTempDir('wgpt-ordinary-stop-');
    try {
      await fs.writeFile(path.join(tree, 'a.txt'), 'needle\n'.repeat(100_001));
      const first = await ordinarySearch([{ name: 'project', path: tree }], null,
        { query: 'needle', mode: 'content', max_results: 50 });
      expect(first.page.total_hits).toBe(100_000);
      expect(first.stopped_because).toBe('hits');
      expect(first.truncated).toBe('page');
      const second = await ordinarySearch([{ name: 'project', path: tree }], null, { cursor: first.next_cursor! });
      expect(second.stopped_because).toBe('hits');
      expect(second.files_scanned).toBe(first.files_scanned);
    } finally { clearOrdinarySearchSnapshots(); await removeTempDir(tree); }
  }, 30_000);

  it('upgrades a request-owned cursor after exact session proof without allowing a foreign session', async () => {
    const tree = await makeTempDir('wgpt-ordinary-alias-');
    const roots = [{ name: 'project', path: tree }];
    const call = (requestId: string, sessionId: string | null): CallContext =>
      ({ caller: { requestId, sessionId } } as CallContext);
    try {
      await fs.writeFile(path.join(tree, 'a.txt'), 'needle\n'.repeat(70));
      const requestId = randomUUID();
      const first = await ordinarySearch(roots, call(requestId, null), { query: 'needle', mode: 'content', max_results: 1 });
      const sessionId = randomUUID();
      expect(observeRequestCorrelation({ requestId, conversationId: randomUUID(), sessionId,
        messageId: randomUUID(), tool: 'find', observedAt: Date.now() })).toBe('stored');
      expect((await ordinarySearch(roots, call(randomUUID(), sessionId), { cursor: first.next_cursor! })).hits).toHaveLength(50);
      await expect(ordinarySearch(roots, call(randomUUID(), randomUUID()), { cursor: first.next_cursor! })).rejects.toThrow(/SEARCH_CURSOR_INVALID/);
    } finally { clearOrdinarySearchSnapshots(); await removeTempDir(tree); }
  });

  it('refuses the 129th live run without evicting previously issued cursors', async () => {
    const tree = await makeTempDir('wgpt-ordinary-global-cap-');
    const roots = [{ name: 'project', path: tree }];
    try {
      await fs.writeFile(path.join(tree, 'a.txt'), 'needle\n'.repeat(70));
      let firstCursor = '';
      let firstCaller: CallContext | null = null;
      for (let i = 0; i < 128; i++) {
        const caller = { caller: { requestId: randomUUID(), sessionId: null } } as CallContext;
        if (i === 0) firstCaller = caller;
        const page = await ordinarySearch(roots, caller, { query: 'needle', mode: 'content', max_results: 1 });
        if (i === 0) firstCursor = page.next_cursor!;
      }
      const foreign = { caller: { requestId: randomUUID(), sessionId: null } } as CallContext;
      await expect(ordinarySearch(roots, foreign, { query: 'needle', mode: 'content', max_results: 1 }))
        .rejects.toThrow(/SEARCH_SNAPSHOT_CAPACITY/);
      // A capacity refusal never drops a previously issued cursor.
      expect((await ordinarySearch(roots, firstCaller, { cursor: firstCursor })).hits).toHaveLength(50);
    } finally { clearOrdinarySearchSnapshots(); await removeTempDir(tree); }
  }, 30_000);

  it('does not consume snapshot capacity for complete one-page searches', async () => {
    const tree = await makeTempDir('wgpt-ordinary-complete-');
    const roots = [{ name: 'project', path: tree }];
    try {
      await fs.writeFile(path.join(tree, 'a.txt'), 'needle\n');
      for (let i = 0; i < 12; i++) {
        const page = await ordinarySearch(roots, null, { query: 'needle', mode: 'content' });
        expect(page.hits).toHaveLength(1);
        expect(page.next_cursor).toBeNull();
      }
    } finally { clearOrdinarySearchSnapshots(); await removeTempDir(tree); }
  });

  it('isolates identified owners from anonymous bearers and refuses ninth live run', async () => {
    const tree = await makeTempDir('wgpt-ordinary-owner-');
    const roots = [{ name: 'project', path: tree }];
    const caller = (id: string): CallContext => ({ caller: { requestId: id, sessionId: null }, allowUnattributed: true } as CallContext);
    try {
      await fs.writeFile(path.join(tree, 'a.txt'), 'needle\n'.repeat(70));
      const anonymous = await ordinarySearch(roots, null, { query: 'needle', mode: 'content', max_results: 1 });
      await expect(ordinarySearch(roots, caller('other'), { cursor: anonymous.next_cursor! })).rejects.toThrow(/SEARCH_CURSOR_INVALID/);
      const owned = await ordinarySearch(roots, caller('one'), { query: 'needle', mode: 'content', max_results: 1 });
      await expect(ordinarySearch(roots, caller('two'), { cursor: owned.next_cursor! })).rejects.toThrow(/SEARCH_CURSOR_INVALID/);
      expect((await ordinarySearch(roots, null, { cursor: anonymous.next_cursor! })).hits).toHaveLength(50);
      for (let i = 1; i < 8; i++) await ordinarySearch(roots, caller('one'), { query: 'needle', mode: 'content', max_results: 1 });
      await expect(ordinarySearch(roots, caller('one'), { query: 'needle', mode: 'content' })).rejects.toThrow(/SEARCH_SNAPSHOT_CAPACITY/);
    } finally { clearOrdinarySearchSnapshots(); await removeTempDir(tree); }
  });
});

describe('large fixture stays within the scan budget', () => {
  it('returns a first page within the 10s deadline over 20,000 small files', async () => {
    const store = createArtifactStore();
    const who = await owner();
    const big = await makeTempDir('wgpt-search-big-');
    try {
      const batch = 500;
      for (let start = 0; start < 20_000; start += batch) {
        await Promise.all(
          Array.from({ length: batch }, (_, offset) => {
            const index = start + offset;
            const dir = path.join(big, `d${index % 100}`);
            return fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(path.join(dir, `f${index}.txt`), 'needle\n'));
          })
        );
      }
      const started = Date.now();
      const page = await managedSearch({ artifacts: store }, who, baseRequest({ realDir: big, query: 'needle', maxResults: 50 }));
      const elapsed = Date.now() - started;
      expect(page.hits).toHaveLength(50);
      expect(elapsed).toBeLessThan(10_000);
      const text = page.hits.map((hit) => JSON.stringify(hit)).join('\n');
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(SEARCH_PAGE_BYTES);
      expect(page.stopped_because === null || page.stopped_because === 'hits' || page.stopped_because === 'time').toBe(true);
      // Recorded, not claimed: the measurement is printed for the run log.
      process.stdout.write(`20k-file first page in ${elapsed} ms (files scanned: ${page.files_scanned})\n`);
    } finally {
      await removeTempDir(big);
    }
  }, 120_000);
});
