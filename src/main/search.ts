/**
 * Filename and content search.
 *
 * The bundled ripgrep runtime is the engine: `--files` for name mode and `--json`
 * streaming for content mode. A bounded JavaScript walk remains as the fallback for
 * upstream UI callers whose environments may lack the binary, but managed agent work
 * selects `searchStream` with `requiredEngine` and is refused outright when ripgrep is
 * missing rather than silently getting a slower engine with different semantics.
 *
 * Every search reports whether it stopped early so the model knows to narrow the scope.
 */

import { rawCreateReadStream as createReadStream, rawPromises as fs } from './rawfs.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { locateRipgrep } from './ripgrep.js';
import { isExcludedFolderName, sniffBinaryBytes, type TextEncoding } from './fsops.js';

/**
 * Skipped by default because they are large and rarely what anyone means. The model
 * can search them by passing an explicit exclude list (including an empty one), so
 * nothing is permanently unreachable.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.gradle',
  '.gradle-user',
  '.idea',
  '.vs',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.cache',
  '.turbo',
  '.go-build-cache',
  '.go-module-cache',
  '.go-tools',
  '.gopath',
  '.tmp',
  '.tmp-go-cache',
  '.tmp-go-path',
  // User-profile/tooling trees that are useful when explicitly opened, but extremely
  // noisy when a model recursively searches a broad root such as a home directory.
  // Because exclusions apply only to child folders, explicitly searching inside one
  // of these paths still works normally.
  '.android',
  '.bun',
  '.claude',
  '.claude-*',
  '.codex',
  '.cursor',
  '.gemini',
  '.npm',
  '.pnpm-store',
  '.yarn',
  // Packaged application output is generated and routinely contains hundreds of
  // Electron/runtime files. Source lives elsewhere and should win the default budget.
  'release',
  'release-*',
  'appdata'
];

/** Files above this are deliberately not fed into content matching; callers must be told. */
export const MAX_CONTENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_SCANNED = 40_000;
const MAX_DIRECTORIES_SCANNED = 10_000;
const CONTENT_CONCURRENCY = 12;

/**
 * One bounded page of retained results.
 *
 * This is the complete structured JSON response bound, not merely a stored-record bound.
 * Pages retain whole hits and issue cursors for everything that cannot fit.
 */
export const SEARCH_PAGE_BYTES = 32 * 1024;
/**
 * Headroom inside a page for the response envelope.
 *
 * Reserves room for page metadata while hits are collected; the final serialized SearchPage
 * is checked against SEARCH_PAGE_BYTES before it is returned.
 */
export const SEARCH_PAGE_RESERVE_BYTES = 2 * 1024;
export const SEARCH_PAGE_HITS = 500;
/**
 * Retained-hit ceiling for one managed run.
 *
 * Deliberately separate from a page: paging continues past a page boundary, so the ceiling
 * is what actually stops an unbounded scan on a huge tree.
 */
export const SEARCH_MAX_HITS = 100_000;
/** Whole-run wall-clock budget, shared by the managed stream and the fallback walk. */
export const SEARCH_TIME_BUDGET_MS = 10_000;
/** The engine managed search requires. There is no slower substitute for agent work. */
export const SEARCH_REQUIRED_ENGINE = 'ripgrep';
/** Preview clip, counted in Unicode code points so astral characters are not cut in half. */
export const MAX_PREVIEW_CHARS = 512;

const TIME_BUDGET_MS = SEARCH_TIME_BUDGET_MS;
/** Preview clip for the legacy buffered `find` path, which upstream UI callers still use. */
const MAX_LINE_CHARS = 300;

export interface SearchHit {
  path: string;
  /** Present for content matches only. */
  line?: number;
  /** Trimmed matching line, for content matches only. */
  text?: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  filesScanned: number;
  truncated: boolean;
  /** Why the search stopped early, if it did. `hits` is the retained-hit ceiling. */
  stoppedBecause: 'limit' | 'time' | 'files' | 'size' | 'hits' | null;
  elapsedMs: number;
}

/**
 * A streamed match.
 *
 * `text` is a preview, never the whole source line: a clipped line carries `clipped` and the
 * full line's character count so the caller reads the exact path/line rather than quoting a
 * silently shortened line back into a patch.
 */
export interface SearchStreamHit extends SearchHit {
  /** True when `text` was clipped at MAX_PREVIEW_CHARS code points. */
  clipped?: boolean;
  /** Full length of the matching line in Unicode code points, when it was clipped. */
  line_chars?: number;
}

/** Receives every hit in engine order. Deliberately synchronous: pages are buffered in memory. */
export interface SearchSink {
  onHit(hit: SearchStreamHit): void;
}

export interface SearchStreamRequest extends Omit<SearchRequest, 'maxResults'> {
  /** Retained-hit ceiling for this run; defaults to SEARCH_MAX_HITS. */
  maxHits?: number;
  /** True when `realDir` names a file rather than a directory. */
  targetIsFile?: boolean;
}

/**
 * Managed search without ripgrep.
 *
 * Managed agent work refuses rather than falling back: a slower walker with different
 * ordering, exclusion and coverage semantics would silently change what the model believes
 * it searched.
 */
export class SearchEngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchEngineUnavailableError';
  }
}

/** Ripgrep failed for a reason other than a proven pattern parse error. */
export class SearchEngineFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchEngineFailureError';
  }
}

/** A proven regex or glob parse error in caller-supplied search input. */
export class SearchPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchPatternError';
  }
}

/**
 * Clip a line to a bounded preview.
 *
 * Managed search counts Unicode code points so an astral character is never cut in half and a
 * clipped line's reported length is the length a reader sees. The legacy buffered path keeps
 * its original UTF-16 slice exactly, because its output shape is pinned by existing UI tests
 * and changing a 300-unit clip to a 300-point clip would silently widen it.
 */
export function clipPreview(
  line: string,
  limit: number = MAX_PREVIEW_CHARS,
  codePoints = true
): { text: string; clipped: boolean; chars: number } {
  if (line.length <= limit) return { text: line, clipped: false, chars: line.length };
  if (!codePoints) return { text: `${line.slice(0, limit)}…`, clipped: true, chars: line.length };
  const points = Array.from(line);
  if (points.length <= limit) return { text: line, clipped: false, chars: points.length };
  return { text: `${points.slice(0, limit).join('')}…`, clipped: true, chars: points.length };
}

export interface SearchRequest {
  realDir: string;
  virtualDir: string;
  query: string;
  mode: 'name' | 'content';
  include?: string | undefined;
  exclude: readonly string[];
  caseSensitive: boolean;
  regex?: boolean;
  maxResults: number;
  /** Absolute whole-tool deadline shared by every approved root. */
  deadline?: number;
}

/** Translates a glob into a regex. Supports *, ?, ** and nothing else, on purpose. */
export function globToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" spans zero or more directories; a bare "**" spans anything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, caseSensitive ? '' : 'i');
}

function compileIncludeMatcher(pattern: string, caseSensitive: boolean): (relPath: string) => boolean {
  const re = globToRegExp(pattern, caseSensitive);
  const matchBaseName = !pattern.includes('/');
  return (relPath: string): boolean => {
    if (re.test(relPath)) return true;
    // A pattern with no slash is conventionally matched against the file name alone.
    return matchBaseName && re.test(path.basename(relPath));
  };
}

/** Translate the connector's deliberately small glob grammar into ripgrep's richer grammar. */
function ripgrepIncludeGlob(pattern: string): string {
  let out = '';
  for (const char of pattern) {
    // These are the only metacharacters the connector itself promises.
    if (char === '*' || char === '?' || char === '/') {
      out += char;
      continue;
    }
    // Ripgrep assigns extra meaning to these; the connector treats them literally.
    if (char === '\\' || char === '[' || char === ']' || char === '{' || char === '}' || char === '!') {
      out += `\\${char}`;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Converts the connector's folder-name exclude syntax to ripgrep's glob syntax.
 *
 * Excludes are deliberately much simpler than globs: a folder name is literal, except for one
 * optional trailing `*` meaning "this name prefix". The JS fallback enforces exactly that and is
 * case-insensitive, so passing the raw text to `rg --glob` was wrong in two ways: stored casing
 * such as `BUILD` bypassed `build`, and characters such as `[` acquired glob semantics. Escape
 * every glob metacharacter in the literal part and use `--iglob` for parity.
 */
function ripgrepExcludeGlob(raw: string): string {
  const prefix = raw.endsWith('*');
  const literal = prefix ? raw.slice(0, -1) : raw;
  const escaped = literal.replace(/[\\*?\[\]{}]/g, '\\$&');
  return `!**/${escaped}${prefix ? '*' : ''}/**`;
}

function textEncodingFromHead(head: Buffer): TextEncoding {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

/** The shape of a ripgrep `--json` line, read defensively because it is external input. */
function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    return jsonObject(JSON.parse(line));
  } catch {
    return null;
  }
}

/** Extra knobs the managed streaming path needs from the same ripgrep runner. */
interface RipgrepRunOptions {
  /** Receives every hit in engine order instead of accumulating it in memory. */
  sink?: SearchSink;
  /** Retained-hit ceiling for this run; defaults to the buffered `maxResults`. */
  maxHits?: number;
  /** What reaching the ceiling means: a caller limit, or the managed retained-hit ceiling. */
  ceilingReason?: 'limit' | 'hits';
  /** Preview clip in Unicode code points; managed search uses MAX_PREVIEW_CHARS. */
  previewChars?: number;
  /** Count the clip in code points rather than UTF-16 units. Managed search does. */
  previewCodePoints?: boolean;
}

async function searchWithRipgrep(
  executable: string,
  req: SearchRequest,
  realTarget: string,
  virtualTarget: string,
  targetIsFile = false,
  options: RipgrepRunOptions = {}
): Promise<SearchOutcome> {
  const started = Date.now();
  const deadline = Math.min(started + TIME_BUDGET_MS, req.deadline ?? Number.POSITIVE_INFINITY);
  if (deadline <= started) {
    return { hits: [], filesScanned: 0, truncated: true, stoppedBecause: 'time', elapsedMs: 0 };
  }
  const maxHits = options.maxHits ?? req.maxResults;
  const ceilingReason = options.ceilingReason ?? 'limit';
  const previewChars = options.previewChars ?? MAX_LINE_CHARS;
  const sink = options.sink;
  const args = [
    '--json',
    '--line-number',
    '--color',
    'never',
    '--hidden',
    '--no-ignore',
    '--max-filesize',
    String(MAX_CONTENT_FILE_BYTES)
  ];
  if (!req.caseSensitive) args.push('--ignore-case');
  if (!req.regex) args.push('--fixed-strings');
  if (req.include) args.push(req.caseSensitive ? '--glob' : '--iglob', ripgrepIncludeGlob(req.include));
  for (const excluded of req.exclude) args.push('--iglob', ripgrepExcludeGlob(excluded));
  args.push('--', req.query, targetIsFile ? realTarget : '.');

  return new Promise<SearchOutcome>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: targetIsFile ? path.dirname(realTarget) : realTarget,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const hits: SearchHit[] = [];
    let filesScanned = 0;
    let stdout = '';
    let stderr = '';
    let stoppedBecause: SearchOutcome['stoppedBecause'] = null;
    let settled = false;
    // Counted separately from `hits`: the managed sink is the only record of a streamed hit,
    // so the ceiling has to be enforced against the count, not the (empty) array.
    let delivered = 0;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve({
        hits,
        filesScanned,
        truncated: stoppedBecause !== null,
        stoppedBecause,
        elapsedMs: Date.now() - started
      });
    };

    const consider = (line: string): void => {
      if (!line) return;
      const event = parseJsonObject(line);
      if (event === null) return;
      if (event['type'] === 'summary') {
        // `begin` is emitted once per file that *has* a match, so counting it reported
        // matches, not coverage. The summary is the only event that knows how many files
        // were actually searched.
        const data = jsonObject(event['data']);
        const stats = jsonObject(data?.['stats']);
        const searches = Number(stats?.['searches']);
        if (Number.isSafeInteger(searches)) filesScanned = searches;
        return;
      }
      if (event['type'] !== 'match') return;
      // Killing the child does not stop this. The pipe already holds whatever ripgrep
      // wrote before the signal landed, and every buffered line still arrives here, so
      // without this guard a maxResults of 3 could return 9.
      if (stoppedBecause !== null) return;
      const data = jsonObject(event['data']);
      const lineNo = Number(data?.['line_number']);
      // With a target of "." and cwd set, ripgrep reports paths as ".\README.md". Left
      // alone that becomes "/root/./README.md" and no caller can match it against the
      // path it asked about.
      const rawPath = String(jsonObject(data?.['path'])?.['text'] ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');
      const rawText = String(jsonObject(data?.['lines'])?.['text'] ?? '').replace(/\r?\n$/, '');
      const trimmed = rawText.trim();
      const hitPath = targetIsFile
        ? virtualTarget
        : `${virtualTarget}/${rawPath}`.replace(/\/+/g, '/').replace(/\/\.\//g, '/');
      const preview = clipPreview(trimmed, previewChars, options.previewCodePoints ?? false);
      const hit: SearchStreamHit = {
        path: hitPath,
        line: Number.isSafeInteger(lineNo) ? lineNo : undefined,
        text: preview.text
      };
      if (sink) {
        if (preview.clipped) {
          hit.clipped = true;
          hit.line_chars = preview.chars;
        }
        sink.onHit(hit);
      } else {
        hits.push(hit);
      }
      delivered++;
      if (delivered >= maxHits && stoppedBecause === null) {
        stoppedBecause = ceilingReason;
        child.kill();
      }
    };

    // A matched path or line can hold any UTF-8, and the pipe splits it wherever the kernel
    // buffer fills. Decoding each chunk on its own turned a character that straddled two chunks
    // into U+FFFD — a path that names nothing, and a hit that then matched nothing. The stream's
    // own decoder holds a partial sequence until the rest of it arrives.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let consumed = 0;
      for (;;) {
        const newline = stdout.indexOf('\n', consumed);
        if (newline === -1) break;
        consider(stdout.slice(consumed, newline).trim());
        consumed = newline + 1;
      }
      if (consumed > 0) stdout = stdout.slice(consumed);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(new SearchEngineUnavailableError(`ripgrep could not start${code ? ` (${code})` : ''}`));
    });
    child.once('close', (code) => {
      if (stdout.trim()) consider(stdout.trim());
      // rg uses 1 for "no matches". A deliberate limit/time kill can return any code.
      if (stoppedBecause !== null || code === 0 || code === 1) finish();
      // Exit 2 is the engine rejecting the request: an invalid regex or glob, most often, but
      // also an IO failure on a target that vanished or cannot be read. Only a parse diagnostic
      // is repeated, and only its reason — never rg's raw stderr, which for an exact file echoes
      // the hidden native approved-root path.
      else if (code === 2) {
        finish(exitTwoFailure(stderr, 'search'));
      }
      // Never surface rg's raw stderr otherwise. The model only needs the backend verdict.
      else finish(new SearchEngineFailureError(`ripgrep search failed${code === null ? '' : ` (exit ${code})`}`));
    });
    const timer = setTimeout(() => {
      if (stoppedBecause === null) stoppedBecause = 'time';
      child.kill();
    }, Math.max(1, deadline - Date.now()));
  });
}

/**
 * rg's own parse diagnostic for a bad pattern or glob, or null when exit 2 was something else.
 *
 * Only these two shapes are safe to repeat: they quote the pattern the caller itself supplied. A
 * regex error prints a header, the rewritten pattern and then the reason; the reason is the only
 * part that tells the caller what to fix, so that is what is kept. Every other exit-2 stderr is
 * withheld, because for an explicitly named file rg echoes the hidden native approved-root path
 * it was handed, and that path is not the model's to read.
 */
function patternDiagnostic(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const header = lines.findIndex((line) => /^rg: (?:regex parse error:|error parsing glob\b)/.test(line));
  if (header === -1) return null;
  const reason = lines.slice(header + 1).find((line) => line.startsWith('error: '));
  const detail = (reason ?? lines[header]!).replace(/^(?:rg|error): /, '');
  return detail.slice(0, 200);
}

/**
 * The tool error for rg's exit 2.
 *
 * Exit 2 means "the request failed", which is a bad pattern or glob — a caller-fixable mistake
 * worth quoting back — or an IO failure such as a missing or unreadable target, which is not a
 * pattern error at all and whose stderr names the native path.
 */
function exitTwoFailure(stderr: string, action: 'search' | 'listing'): SearchEngineFailureError | SearchPatternError {
  const diagnostic = patternDiagnostic(stderr);
  if (diagnostic === null) return new SearchEngineFailureError(`ripgrep ${action} failed (exit 2)`);
  return new SearchPatternError(`Invalid search pattern: ${diagnostic}`);
}

/**
 * Managed filename streaming.
 *
 * `rg --files` is the listing engine; the query substring and the include contract are then
 * applied in order so a caller sees exactly the file-name semantics the buffered `find` mode
 * documents. NUL separation is what makes a path containing a newline still one record.
 */
async function streamNamesWithRipgrep(
  executable: string,
  req: SearchStreamRequest,
  sink: SearchSink
): Promise<SearchOutcome> {
  const started = Date.now();
  const deadline = Math.min(started + TIME_BUDGET_MS, req.deadline ?? Number.POSITIVE_INFINITY);
  if (deadline <= started) {
    return { hits: [], filesScanned: 0, truncated: true, stoppedBecause: 'time', elapsedMs: 0 };
  }
  const maxHits = req.maxHits ?? SEARCH_MAX_HITS;
  const targetIsFile = req.targetIsFile === true;
  const includeMatcher = req.include ? compileIncludeMatcher(req.include, req.caseSensitive) : null;
  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  const matches = (name: string): boolean =>
    needle === '' || (req.caseSensitive ? name : name.toLowerCase()).includes(needle);

  // One explicit file needs no subprocess: ripgrep ignores glob filters for a named file
  // anyway, and the connector's include contract has to be applied here either way.
  if (targetIsFile) {
    const name = path.basename(req.virtualDir.replace(/\\/g, '/'));
    const included = !includeMatcher || includeMatcher(name);
    if (included && matches(name)) sink.onHit({ path: req.virtualDir });
    return {
      hits: [],
      filesScanned: 1,
      truncated: false,
      stoppedBecause: null,
      elapsedMs: Date.now() - started
    };
  }

  const args = ['--files', '--null', '--hidden', '--no-ignore'];
  if (req.include) args.push(req.caseSensitive ? '--glob' : '--iglob', ripgrepIncludeGlob(req.include));
  for (const excluded of req.exclude) args.push('--iglob', ripgrepExcludeGlob(excluded));
  args.push('--', '.');

  return new Promise<SearchOutcome>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: req.realDir,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let filesScanned = 0;
    let delivered = 0;
    let stdout = '';
    let stderr = '';
    let stoppedBecause: SearchOutcome['stoppedBecause'] = null;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        resolve({
          hits: [],
          filesScanned,
          truncated: stoppedBecause !== null,
          stoppedBecause,
          elapsedMs: Date.now() - started
        });
      }
    };

    const consider = (raw: string): void => {
      if (raw === '') return;
      const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '');
      if (rel === '') return;
      filesScanned++;
      if (stoppedBecause !== null) return;
      if (!matches(path.basename(rel))) return;
      const virtualPath = `${req.virtualDir}/${rel}`.replace(/\/+/g, '/').replace(/\/\.\//g, '/');
      sink.onHit({ path: virtualPath });
      delivered++;
      if (delivered >= maxHits && stoppedBecause === null) {
        stoppedBecause = 'hits';
        child.kill();
      }
    };

    // `--null` records a raw filename, and a filename is arbitrary bytes in the filesystem's
    // UTF-8. Decoding each chunk alone corrupted a name whose character straddled two reads, so
    // the listed path no longer matched the file the caller asked about. Let the stream hold the
    // partial sequence across chunks.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let consumed = 0;
      for (;;) {
        const end = stdout.indexOf('\0', consumed);
        if (end === -1) break;
        consider(stdout.slice(consumed, end));
        consumed = end + 1;
      }
      if (consumed > 0) stdout = stdout.slice(consumed);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(new SearchEngineUnavailableError(`ripgrep could not start${code ? ` (${code})` : ''}`));
    });
    child.once('close', (code) => {
      if (stdout) consider(stdout);
      // rg uses 1 for "no matches" and for an empty listing; both are empty successes.
      if (stoppedBecause !== null || code === 0 || code === 1) finish();
      // Same exit-2 split as content search: a bad glob is a caller-fixable pattern mistake
      // worth quoting, an IO failure on the walk root is not and must not echo its path.
      else if (code === 2) {
        finish(exitTwoFailure(stderr, 'listing'));
      } else finish(new SearchEngineFailureError(`ripgrep listing failed${code === null ? '' : ` (exit ${code})`}`));
    });
    const timer = setTimeout(() => {
      if (stoppedBecause === null) stoppedBecause = 'time';
      child.kill();
    }, Math.max(1, deadline - Date.now()));
  });
}

/**
 * Managed streaming search.
 *
 * Same engine and same argument construction as `search`, but hits are delivered to a sink as
 * they arrive and the ceiling is the retained-hit budget rather than one response. Managed
 * callers get ripgrep or a refusal; there is no slower substitute for agent work.
 */
export async function searchStream(
  req: SearchStreamRequest,
  sink: SearchSink
): Promise<SearchOutcome> {
  const ripgrep = locateRipgrep();
  if (!ripgrep) {
    throw new SearchEngineUnavailableError(
      'SEARCH_ENGINE_UNAVAILABLE: the bundled ripgrep runtime was not found. ' +
        'Reinstall the app or run `npm run rg` so managed search can use it.'
    );
  }
  if (req.mode === 'name') return streamNamesWithRipgrep(ripgrep, req, sink);

  // Ripgrep deliberately ignores glob filters when the search target is one explicit file, so
  // the connector's include contract is applied here to keep both engines in agreement.
  if (req.targetIsFile === true && req.include) {
    const name = path.basename(req.virtualDir.replace(/\\/g, '/'));
    if (!compileIncludeMatcher(req.include, req.caseSensitive)(name)) {
      return { hits: [], filesScanned: 1, truncated: false, stoppedBecause: null, elapsedMs: 0 };
    }
  }

  // An explicitly named oversized file was never searched, and saying "no matches" would be
  // false. Both managed and buffered paths report the same stop reason for that case.
  if (req.targetIsFile) {
    try {
      const stat = await fs.stat(req.realDir);
      if (stat.size > MAX_CONTENT_FILE_BYTES) {
        return { hits: [], filesScanned: 0, truncated: true, stoppedBecause: 'size', elapsedMs: 0 };
      }
    } catch {
      /* A missing/unreadable file keeps the engine's own verdict below. */
    }
  }
  return searchWithRipgrep(
    ripgrep,
    { ...req, maxResults: req.maxHits ?? SEARCH_MAX_HITS },
    req.realDir,
    req.virtualDir,
    req.targetIsFile === true,
    {
      sink,
      maxHits: req.maxHits ?? SEARCH_MAX_HITS,
      ceilingReason: 'hits',
      previewChars: MAX_PREVIEW_CHARS,
      previewCodePoints: true
    }
  );
}

export async function search(req: SearchRequest): Promise<SearchOutcome> {
  if (req.mode === 'content') {
    const ripgrep = locateRipgrep();
    if (ripgrep) return searchWithRipgrep(ripgrep, req, req.realDir, req.virtualDir);
    if (req.regex) throw new Error('Regex content search requires the bundled ripgrep runtime.');
  }
  const started = Date.now();
  const deadline = Math.min(started + TIME_BUDGET_MS, req.deadline ?? Number.POSITIVE_INFINITY);
  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let directoriesScanned = 0;
  let stoppedBecause: SearchOutcome['stoppedBecause'] = null;

  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  const includeMatcher = req.include ? compileIncludeMatcher(req.include, req.caseSensitive) : null;
  const candidates: Array<{ real: string; rel: string }> = [];

  const outOfBudget = (): boolean => {
    if (Date.now() > deadline) {
      stoppedBecause = 'time';
      return true;
    }
    if (filesScanned >= MAX_FILES_SCANNED) {
      stoppedBecause = 'files';
      return true;
    }
    return false;
  };

  const pendingDirectories: Array<{ dir: string; rel: string }> = [{ dir: req.realDir, rel: '' }];
  // Queue head cursor rather than Array.shift(): a broad tree can enqueue thousands of
  // directories, and shifting the front reindexes the whole remaining array on every BFS
  // step. Keeping the same append-only breadth-first order makes traversal O(n) instead of
  // adding an avoidable O(n²) queue-management term.
  let directoryHead = 0;
  while (directoryHead < pendingDirectories.length && !outOfBudget()) {
    if (directoriesScanned >= MAX_DIRECTORIES_SCANNED) {
      stoppedBecause = 'files';
      break;
    }
    const current = pendingDirectories[directoryHead++]!;
    directoriesScanned++;
    let directory;
    try {
      directory = await fs.opendir(current.dir);
    } catch {
      continue;
    }
    try {
      for await (const dirent of directory) {
        if (outOfBudget()) break;
        const childRel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          if (!isExcludedFolderName(dirent.name, req.exclude)) {
            pendingDirectories.push({ dir: path.join(current.dir, dirent.name), rel: childRel });
          }
          continue;
        }
        if (!dirent.isFile()) continue;
        filesScanned++;
        if (includeMatcher && !includeMatcher(childRel)) continue;
        if (req.mode === 'name') {
          const haystack = req.caseSensitive ? dirent.name : dirent.name.toLowerCase();
          if (needle === '' || haystack.includes(needle)) {
            hits.push({ path: `${req.virtualDir}/${childRel}` });
            if (hits.length >= req.maxResults) {
              stoppedBecause = 'limit';
              break;
            }
          }
        } else {
          candidates.push({ real: path.join(current.dir, dirent.name), rel: childRel });
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (stoppedBecause === 'limit') break;
  }

  if (req.mode === 'content' && stoppedBecause !== 'limit') {
    await scanContents(req, candidates, hits, deadline, (reason) => {
      stoppedBecause = reason;
    });
  }

  return {
    hits,
    filesScanned,
    truncated: stoppedBecause !== null,
    stoppedBecause,
    elapsedMs: Date.now() - started
  };
}

async function scanContents(
  req: SearchRequest,
  candidates: Array<{ real: string; rel: string }>,
  hits: SearchHit[],
  deadline: number,
  stop: (reason: 'limit' | 'time') => void
): Promise<void> {
  let index = 0;
  let done = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (done) return;
      if (Date.now() > deadline) {
        done = true;
        stop('time');
        return;
      }
      const item = candidates[index++];
      if (!item) return;
      if (hits.length >= req.maxResults) {
        done = true;
        stop('limit');
        return;
      }
      const found = await scanOneFile(item.real, req);
      for (const hit of found) {
        if (hits.length >= req.maxResults) {
          done = true;
          stop('limit');
          return;
        }
        hits.push({ path: `${req.virtualDir}/${item.rel}`, line: hit.line, text: hit.text });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONTENT_CONCURRENCY, candidates.length || 1) }, worker)
  );
}

export async function searchOneFile(
  realPath: string,
  virtualPath: string,
  req: Pick<SearchRequest, 'query' | 'mode' | 'include' | 'caseSensitive' | 'regex' | 'maxResults' | 'deadline'>
): Promise<SearchOutcome> {
  const started = Date.now();
  const rel = path.basename(virtualPath);
  // Ripgrep deliberately ignores glob filters when the search target is one explicit file.
  // Apply the connector's include contract before selecting either backend so both paths agree.
  if (req.include && !compileIncludeMatcher(req.include, req.caseSensitive)(rel)) {
    return { hits: [], filesScanned: 1, truncated: false, stoppedBecause: null, elapsedMs: Date.now() - started };
  }
  if (req.mode === 'content') {
    // Both the bundled-rg path (`--max-filesize`) and the JS fallback intentionally skip files
    // above this ceiling. For an explicitly named file, returning plain "No matches" is false:
    // the file was never searched. Surface the stop reason before either backend can hide it.
    try {
      const stat = await fs.stat(realPath);
      if (stat.size > MAX_CONTENT_FILE_BYTES) {
        return {
          hits: [],
          filesScanned: 0,
          truncated: true,
          stoppedBecause: 'size',
          elapsedMs: Date.now() - started
        };
      }
    } catch {
      // Preserve the backend's existing missing/unreadable-file behaviour below.
    }
  }
  if (req.mode === 'content') {
    const ripgrep = locateRipgrep();
    if (ripgrep) {
      return searchWithRipgrep(
        ripgrep,
        { ...req, realDir: path.dirname(realPath), virtualDir: path.dirname(virtualPath).replace(/\\/g, '/'), exclude: [] },
        realPath,
        virtualPath,
        true
      );
    }
    if (req.regex) throw new Error('Regex content search requires the bundled ripgrep runtime.');
  }
  if (req.mode === 'name') {
    const haystack = req.caseSensitive ? rel : rel.toLowerCase();
    const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
    const hits = needle === '' || haystack.includes(needle) ? [{ path: virtualPath }] : [];
    return { hits, filesScanned: 1, truncated: false, stoppedBecause: null, elapsedMs: Date.now() - started };
  }
  const found = await scanOneFile(realPath, {
    realDir: path.dirname(realPath),
    virtualDir: path.dirname(virtualPath).replace(/\\/g, '/'),
    query: req.query,
    mode: 'content',
    include: req.include,
    exclude: [],
    caseSensitive: req.caseSensitive,
    maxResults: req.maxResults
  });
  const limited = found.slice(0, req.maxResults);
  return {
    hits: limited.map((hit) => ({ path: virtualPath, line: hit.line, text: hit.text })),
    filesScanned: 1,
    truncated: found.length > limited.length,
    stoppedBecause: found.length > limited.length ? 'limit' : null,
    elapsedMs: Date.now() - started
  };
}

async function scanOneFile(
  realPath: string,
  req: SearchRequest
): Promise<Array<{ line: number; text: string }>> {
  let stat;
  try {
    stat = await fs.stat(realPath);
  } catch {
    return [];
  }
  if (stat.size === 0 || stat.size > MAX_CONTENT_FILE_BYTES) return [];
  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  let regex: RegExp | null = null;
  if (req.regex) {
    try {
      regex = new RegExp(req.query, req.caseSensitive ? '' : 'i');
    } catch {
      // JS syntax errors include the full supplied expression; keep the refusal bounded.
      throw new SearchPatternError('Invalid search regex.');
    }
  }
  const results: Array<{ line: number; text: string }> = [];
  let lineNo = 0;
  let carry = '';
  let decoder: TextDecoder | null = null;

  const consider = (line: string): void => {
    lineNo++;
    const haystack = req.caseSensitive ? line : line.toLowerCase();
    if (regex ? !regex.test(line) : !haystack.includes(needle)) return;
    const trimmed = line.trim();
    results.push({
      line: lineNo,
      text: trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed
    });
  };

  const stream = createReadStream(realPath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const data = chunk as Buffer;
      if (decoder === null) {
        if (sniffBinaryBytes(data.subarray(0, Math.min(8192, data.length)))) return [];
        decoder = new TextDecoder(textEncodingFromHead(data));
      }
      carry += decoder.decode(data, { stream: true });
      let at = carry.indexOf('\n');
      while (at !== -1) {
        consider(carry.slice(0, at).replace(/\r$/, ''));
        carry = carry.slice(at + 1);
        at = carry.indexOf('\n');
      }
      // A file with no newlines would otherwise grow `carry` without bound.
      if (carry.length > MAX_CONTENT_FILE_BYTES) break;
    }
    if (decoder !== null) carry += decoder.decode();
    if (carry.length > 0) consider(carry.replace(/\r$/, ''));
  } catch {
    return results;
  } finally {
    stream.destroy();
  }
  return results;
}
