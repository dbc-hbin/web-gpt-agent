import { describe, expect, it } from 'vitest';
import { TextMatchError, applyTextEdit, findSpans } from '../src/main/text-match.js';

/** The exact shape read_file hands the model: logical LF lines, line-number prefix stripped. */
function asReadOutput(fileText: string, firstLine: number, lastLine: number): string {
  const lines = fileText.split(/\r\n|\n|\r/);
  return lines.slice(firstLine - 1, lastLine).join('\n');
}

describe('edit matching across line endings', () => {
  it('finds a multi-line snippet copied from read_file inside a CRLF file', () => {
    const file = ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\r\n');
    const snippet = asReadOutput(file, 1, 2);

    expect(snippet).toBe('const a = 1;\nconst b = 2;');
    expect(findSpans(file, snippet)).not.toBeNull();
  });

  it('finds a snippet spanning the seam of a mixed-ending file', () => {
    // The exact shape PowerShell string surgery left behind in this repository: a CRLF
    // file with a handful of lone LF lines. Both of the old two-candidate forms failed
    // here, because neither all-CRLF nor all-LF describes the window.
    const file = 'alpha\r\nbeta\ngamma\r\ndelta';
    const snippet = asReadOutput(file, 1, 4);

    expect(findSpans(file, snippet)).not.toBeNull();
  });

  it('preserves every untouched terminator inside and outside the replaced span', () => {
    const file = 'alpha\r\nbeta\ngamma\r\ndelta\r\nomega';
    const snippet = asReadOutput(file, 2, 4);
    const applied = applyTextEdit(file, {
      oldText: snippet,
      newText: snippet.replace('gamma', 'GAMMA')
    });

    expect(applied.text).toBe('alpha\r\nbeta\nGAMMA\r\ndelta\r\nomega');
    // Byte-for-byte: only the token changed. Nothing was normalised to a majority ending.
    expect(applied.text.replace('GAMMA', 'gamma')).toBe(file);
  });

  it('keeps a file that ends without a newline ending without one', () => {
    const file = 'first\r\nlast';
    const applied = applyTextEdit(file, { oldText: 'first\nlast', newText: 'first\nfinal' });
    expect(applied.text).toBe('first\r\nfinal');
  });

  it('gives genuinely new lines the file majority terminator', () => {
    const file = 'one\r\ntwo\r\n';
    const applied = applyTextEdit(file, { oldText: 'two', newText: 'two\nthree' });
    expect(applied.text).toBe('one\r\ntwo\r\nthree\r\n');
  });
});

describe('edit replacement is literal', () => {
  // String.prototype.replace expands these in the replacement even when the pattern is a
  // plain string, so the old implementation silently wrote different bytes than requested.
  const hazards = ['$&', '$`', "$'", '$1', '$$', 'char.replace(/x/, "\\$&")'];

  for (const hazard of hazards) {
    it(`writes ${JSON.stringify(hazard)} verbatim`, () => {
      const applied = applyTextEdit('const value = PLACEHOLDER;\n', {
        oldText: 'PLACEHOLDER',
        newText: hazard
      });
      expect(applied.text).toBe(`const value = ${hazard};\n`);
    });
  }

  it('writes dollar patterns verbatim under replaceAll too', () => {
    const applied = applyTextEdit('a X b X\n', { oldText: 'X', newText: '$&', replaceAll: true });
    expect(applied.text).toBe('a $& b $&\n');
    expect(applied.replacements).toBe(2);
  });
});

describe('edit ambiguity', () => {
  it('refuses a non-unique oldText and names the lines', () => {
    const file = 'value = 1;\nother();\nvalue = 1;\n';
    expect(() => applyTextEdit(file, { oldText: 'value = 1;', newText: 'value = 2;' })).toThrow(
      /occurs 2 times, at lines 1, 3/
    );
  });

  it('replaces every occurrence when asked', () => {
    const file = 'value = 1;\nother();\nvalue = 1;\n';
    const applied = applyTextEdit(file, { oldText: 'value = 1;', newText: 'value = 2;', replaceAll: true });
    expect(applied.text).toBe('value = 2;\nother();\nvalue = 2;\n');
    expect(applied.replacements).toBe(2);
  });

  it('inherits each occurrence own terminators under replaceAll in a mixed file', () => {
    const file = 'x = 1;\r\nmid\nx = 1;\nend';
    const applied = applyTextEdit(file, { oldText: 'x = 1;\n', newText: 'x = 2;\n', replaceAll: true });
    expect(applied.text).toBe('x = 2;\r\nmid\nx = 2;\nend');
  });

  it('explains what to do when oldText is missing', () => {
    expect(() => applyTextEdit('hello\n', { oldText: 'nope', newText: 'x' })).toThrow(TextMatchError);
    expect(() => applyTextEdit('hello\n', { oldText: 'nope', newText: 'x' })).toThrow(/without the line-number prefix/);
  });

  it('rejects an empty oldText rather than matching everywhere', () => {
    expect(() => applyTextEdit('hello\n', { oldText: '', newText: 'x' })).toThrow(TextMatchError);
  });
});

describe('edit typography tolerance', () => {
  it('matches an ASCII file through a curly quote the model came back with', () => {
    const file = "const label = 'ready';\n";
    const applied = applyTextEdit(file, { oldText: "label = ‘ready’", newText: "label = 'set'" });
    expect(applied.text).toBe("const label = 'set';\n");
  });

  it('does not forgive whitespace drift, which is apply_patch territory', () => {
    // Trailing whitespace the model dropped when it copied the line, and a tab/space
    // mismatch. Both are inside apply_patch's ladder and outside this one; the error has
    // to say so rather than leaving the caller to guess why an obvious line "isn't there".
    expect(() => applyTextEdit('call();   \n', { oldText: 'call();\n', newText: 'other();\n' })).toThrow(
      /use apply_patch instead/
    );
    expect(() => applyTextEdit('\tindented();\n', { oldText: '    indented();\n', newText: 'x();\n' })).toThrow(
      /use apply_patch instead/
    );
  });
});
