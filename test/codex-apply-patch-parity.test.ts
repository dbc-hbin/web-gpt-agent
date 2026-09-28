import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
  executeApplyPatch,
  parsePatch,
  verifyApplyPatchArgs
} from '../src/main/codex/apply-patch/index.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'clf-apply-patch-parity-'));
  roots.push(root);
  return root;
}

describe('Codex apply_patch runtime parity', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('parses the current optional Environment ID preamble', () => {
    const parsed = parsePatch(`*** Begin Patch
*** Environment ID: remote-test
*** Add File: hello.txt
+hello
*** End Patch`);

    expect(parsed.environmentId).toBe('remote-test');
    expect(parsed.hunks).toHaveLength(1);
  });

  it('preserves already-committed hunks when a later runtime filesystem operation fails', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, 'directory-target'));

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Add File: committed.txt
+committed
*** Delete File: directory-target
*** End Patch`
    });

    expect(result.exitCode).toBe(1);
    await expect(readFile(path.join(root, 'committed.txt'), 'utf8')).resolves.toBe('committed\n');
    expect(result.delta.changes).toEqual([
      {
        path: path.join(root, 'committed.txt'),
        change: { kind: 'add', content: 'committed\n', overwrittenContent: null }
      }
    ]);
    expect(result.delta.exact).toBe(false);
  });

  it('records overwritten destination content when a move replaces an existing file', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'source.txt');
    const destination = path.join(root, 'destination.txt');
    await writeFile(source, 'old\n');
    await writeFile(destination, 'destination-before\n');

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-old
+new
*** End Patch`
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(destination, 'utf8')).resolves.toBe('new\n');
    await expect(readFile(source, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.delta.changes).toEqual([
      {
        path: source,
        change: {
          kind: 'update',
          movePath: destination,
          oldContent: 'old\n',
          overwrittenMoveContent: 'destination-before\n',
          newContent: 'new\n'
        }
      }
    ]);
  });

  it('refuses a move to the same file before write-then-remove can delete it', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'source.txt');
    await writeFile(source, 'old\n');
    const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: ./source.txt
@@
-old
+new
*** End Patch`;

    await expect(
      verifyApplyPatchArgs(parsePatch(patch), root, DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE)
    ).rejects.toThrow(/source and destination.*same file/i);
    await expect(readFile(source, 'utf8')).resolves.toBe('old\n');
  });

  it('preflights a later move destination before an earlier hunk can become a partial patch', async () => {
    const root = await tempRoot();
    const first = path.join(root, 'first.txt');
    const source = path.join(root, 'source.txt');
    await writeFile(first, 'before\n');
    await writeFile(source, 'source\n');
    await mkdir(path.join(root, 'directory-target'));

    const patch = `*** Begin Patch
*** Update File: first.txt
@@
-before
+after
*** Update File: source.txt
*** Move to: directory-target
@@
-source
+moved
*** End Patch`;

    // The raw runtime is sequential by design. The model-facing adapter relies on this dry run
    // to turn deterministic later-target failures into an all-or-nothing refusal instead.
    await expect(
      verifyApplyPatchArgs(parsePatch(patch), root, DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE)
    ).rejects.toThrow(/patch target is not a regular file/);
    await expect(readFile(first, 'utf8')).resolves.toBe('before\n');
    await expect(readFile(source, 'utf8')).resolves.toBe('source\n');
  });

  it('matches upstream fuzzy Unicode punctuation when patch context uses ASCII', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'unicode.py');
    await writeFile(target, 'import asyncio  # local import – avoids top‑level dep\n');

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Update File: unicode.py
@@
-import asyncio  # local import - avoids top-level dep
+import asyncio  # HELLO
*** End Patch`
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(target, 'utf8')).resolves.toBe('import asyncio  # HELLO\n');
  });

  it('preserves mixed source line endings in preserve-line-endings mode', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'mixed.txt');
    await writeFile(target, 'a\r\nb\nc\r');

    const result = await executeApplyPatch({
      cwd: root,
      updateFileMode: 'preserve_line_endings',
      patch: `*** Begin Patch
*** Update File: mixed.txt
@@
 a
-b
+B
 c
*** End Patch`
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(target, 'utf8')).resolves.toBe('a\r\nB\r\nc\r');
  });

  it('inserts an empty-old-lines chunk at EOF with the historical trailing newline', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'eof.txt');
    await writeFile(target, 'foo\nbar\nbaz\n');

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Update File: eof.txt
@@
+quux
*** End of File
*** End Patch`
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(target, 'utf8')).resolves.toBe('foo\nbar\nbaz\nquux\n');
  });
});

describe('a second Update File hunk for a path already targeted', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /**
   * Runs the pre-flight verifier and then the applier over the same patch, which is the order
   * tools-core uses. Returns what the file became, having asserted the two agree — the property
   * the deviation in `repeatIsAnOrdinarySecondEdit` exists to restore.
   */
  async function verifyThenApply(root: string, file: string, patch: string): Promise<string> {
    await verifyApplyPatchArgs(parsePatch(patch), root, DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE);
    const result = await executeApplyPatch({ cwd: root, patch });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    return readFile(path.join(root, file), 'utf8');
  }

  it('applies both, where upstream refused the patch its own applier would have taken', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'sample.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst z = 4;\n', 'utf8');

    const twoHeaders = await verifyThenApply(
      root,
      'sample.ts',
      `*** Begin Patch
*** Update File: sample.ts
@@
 const a = 1;
-const b = 2;
+const b = 22;
*** Update File: sample.ts
@@
 const c = 3;
-const z = 4;
+const z = 44;
*** End Patch`
    );

    expect(twoHeaders).toBe('const a = 1;\nconst b = 22;\nconst c = 3;\nconst z = 44;\n');

    // The form the model was required to write instead. Same result, which is the point: the
    // refusal was never protecting a difference in outcome.
    const oneRoot = await tempRoot();
    await writeFile(path.join(oneRoot, 'sample.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst z = 4;\n', 'utf8');
    const oneHeader = await verifyThenApply(
      oneRoot,
      'sample.ts',
      `*** Begin Patch
*** Update File: sample.ts
@@
 const a = 1;
-const b = 2;
+const b = 22;
@@
 const c = 3;
-const z = 4;
+const z = 44;
*** End Patch`
    );
    expect(oneHeader).toBe(twoHeaders);
  });

  it('takes the hunks in order rather than sharing one forward cursor', async () => {
    // Chunks under a single header share a cursor that only moves forward, so this second edit —
    // which is earlier in the file than the first — is exactly the case a merge would break and
    // sequential application handles. The applier reads the file back between hunks; the verifier
    // now hands the same intermediate text to the next hunk instead.
    const root = await tempRoot();
    await writeFile(path.join(root, 'ordered.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

    const content = await verifyThenApply(
      root,
      'ordered.txt',
      `*** Begin Patch
*** Update File: ordered.txt
@@
 beta
-gamma
+gamma-edited
*** Update File: ordered.txt
@@
-alpha
+alpha-edited
 beta
*** End Patch`
    );

    expect(content).toBe('alpha-edited\nbeta\ngamma-edited\n');
  });

  it('lets the second hunk edit what the first one wrote', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'chained.txt'), 'one\ntwo\n', 'utf8');

    const content = await verifyThenApply(
      root,
      'chained.txt',
      `*** Begin Patch
*** Update File: chained.txt
@@
 one
+inserted
 two
*** Update File: chained.txt
@@
 one
-inserted
+replaced
 two
*** End Patch`
    );

    expect(content).toBe('one\nreplaced\ntwo\n');
  });

  it('rewrites a file given as a delete followed by an add', async () => {
    // How the model spells "replace this document wholesale". Two recorded sessions lost a
    // rewritten doc to the duplicate-path refusal in exactly this shape.
    const root = await tempRoot();
    await writeFile(path.join(root, 'notes.md'), 'old heading\nold body\n', 'utf8');

    const content = await verifyThenApply(
      root,
      'notes.md',
      `*** Begin Patch
*** Delete File: notes.md
*** Add File: notes.md
+new heading
+new body
*** End Patch`
    );

    expect(content).toBe('new heading\nnew body\n');
  });

  it('edits a file the same patch had just created', async () => {
    const root = await tempRoot();

    const content = await verifyThenApply(
      root,
      'fresh.ts',
      `*** Begin Patch
*** Add File: fresh.ts
+const fresh = 1;
*** Update File: fresh.ts
@@
-const fresh = 1;
+const fresh = 2;
*** End Patch`
    );

    expect(content).toBe('const fresh = 2;\n');
  });

  it('refuses only what the applier also refuses, and for the same reason', async () => {
    // The invariant the deviation rests on. Each of these names one path more than once, so each
    // used to be a flat `multiple operations target`; what should decide them is whether the
    // applier could have carried them out.
    const sequences = [
      {
        what: 'an update after the patch deleted the file',
        patch: `*** Begin Patch
*** Delete File: sample.ts
*** Update File: sample.ts
@@
-const a = 1;
+const a = 2;
*** End Patch`,
        expected: /Failed to read file to update/
      },
      {
        what: 'an update of a path the patch moved away',
        patch: `*** Begin Patch
*** Update File: sample.ts
*** Move to: moved.ts
@@
-const a = 1;
+const a = 2;
*** Update File: sample.ts
@@
-const a = 2;
+const a = 3;
*** End Patch`,
        expected: /Failed to read file to update/
      },
      {
        what: 'a second update whose context is stale against the first one s result',
        patch: `*** Begin Patch
*** Update File: sample.ts
@@
-const a = 1;
+const a = 2;
*** Update File: sample.ts
@@
-const a = 1;
+const a = 3;
*** End Patch`,
        expected: /Failed to find expected lines/
      }
    ];

    for (const { what, patch, expected } of sequences) {
      const root = await tempRoot();
      await writeFile(path.join(root, 'sample.ts'), 'const a = 1;\n', 'utf8');

      let refusal = '';
      try {
        await verifyApplyPatchArgs(parsePatch(patch), root, DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE);
      } catch (error) {
        refusal = (error as Error).message;
      }
      expect(refusal, what).toMatch(expected);
      expect(refusal, what).not.toMatch(/multiple operations target/);

      // And the applier, given the same patch, fails too. A gate that refused what the applier
      // would have taken is the defect; a gate that takes what the applier would refuse is worse.
      const applied = await executeApplyPatch({ cwd: root, patch });
      expect(applied.exitCode, what).toBe(1);
    }
  });

  it('still refuses a repeat under a path the resolver rejects, before reading anything', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'sample.ts'), 'const a = 1;\n', 'utf8');

    await expect(
      verifyApplyPatchArgs(
        parsePatch(`*** Begin Patch
*** Update File: sample.ts
@@
-const a = 1;
+const a = 2;
*** Update File: sample.ts
@@
-const a = 2;
+const a = 3;
*** End Patch`),
        root,
        DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
        () => {
          throw new Error('path outside the approved roots');
        }
      )
    ).rejects.toThrow(/path outside the approved roots/);
  });
});
