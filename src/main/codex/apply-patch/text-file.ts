/**
 * Port of `codex-rs/apply-patch/src/text_file.rs`.
 *
 * The line scanner walks byte offsets in Rust and UTF-16 offsets here. Both are exact for this
 * purpose: CR and LF are single units in either encoding and can never appear inside a
 * multi-unit character, so the two cursors split at the same places.
 */

/** `(start_index, old_len, new_lines)`. */
export type Replacement = [number, number, string[]];

type LineEnding = 'lf' | 'crlf' | 'cr';

const LINE_ENDING_TEXT: Record<LineEnding, string> = { lf: '\n', crlf: '\r\n', cr: '\r' };

interface SourceLine {
  text: string;
  ending: LineEnding | null;
}

const CARRIAGE_RETURN = 13;
const LINE_FEED = 10;

export class SourceFile {
  private lines: SourceLine[];
  private readonly preferredEnding: LineEnding;

  private constructor(lines: SourceLine[], preferredEnding: LineEnding) {
    this.lines = lines;
    this.preferredEnding = preferredEnding;
  }

  /**
   * Splits contents into logical lines while retaining each line ending.
   *
   * The first existing ending becomes the preferred style for inserted lines; files without an
   * ending default to LF.
   */
  static parse(contents: string): SourceFile {
    const lines: SourceLine[] = [];
    let preferredEnding: LineEnding | null = null;
    let lineStart = 0;
    let cursor = 0;

    while (cursor < contents.length) {
      let ending: LineEnding;
      let endingLength: number;
      const unit = contents.charCodeAt(cursor);
      if (unit === CARRIAGE_RETURN && contents.charCodeAt(cursor + 1) === LINE_FEED) {
        ending = 'crlf';
        endingLength = 2;
      } else if (unit === CARRIAGE_RETURN) {
        ending = 'cr';
        endingLength = 1;
      } else if (unit === LINE_FEED) {
        ending = 'lf';
        endingLength = 1;
      } else {
        cursor += 1;
        continue;
      }
      preferredEnding ??= ending;
      lines.push({ text: contents.slice(lineStart, cursor), ending });
      cursor += endingLength;
      lineStart = cursor;
    }

    if (lineStart < contents.length) {
      lines.push({ text: contents.slice(lineStart), ending: null });
    }

    return new SourceFile(lines, preferredEnding ?? 'lf');
  }

  lineTexts(): string[] {
    return this.lines.map((line) => line.text);
  }

  /**
   * Rebuilds the file from source-ordered, non-overlapping replacements.
   *
   * Unchanged lines retain their original endings, inserted lines use the preferred ending, and
   * every resulting line receives an ending to match apply-patch's historical trailing-newline
   * behavior.
   */
  applyReplacements(replacements: readonly Replacement[]): void {
    const sourceLines = this.lines;
    const newLines: SourceLine[] = [];
    // Stands in for Rust's `by_ref().take(n)`: a shared cursor that a short source simply
    // exhausts rather than overruns.
    let cursor = 0;
    let sourceIndex = 0;

    for (const [startIndex, oldLength, newSegment] of replacements) {
      for (let taken = 0; taken < startIndex - sourceIndex && cursor < sourceLines.length; taken++) {
        newLines.push(sourceLines[cursor++] as SourceLine);
      }
      for (let taken = 0; taken < oldLength && cursor < sourceLines.length; taken++) cursor++;
      for (const text of newSegment) newLines.push({ text, ending: this.preferredEnding });
      sourceIndex = startIndex + oldLength;
    }
    while (cursor < sourceLines.length) newLines.push(sourceLines[cursor++] as SourceLine);
    this.lines = newLines;

    // Updates have historically added a trailing newline. This also gives an unterminated last
    // line an ending if an insertion moved it inward.
    for (const line of this.lines) line.ending ??= this.preferredEnding;
  }

  intoContents(): string {
    let contents = '';
    for (const line of this.lines) {
      contents += line.text;
      if (line.ending !== null) contents += LINE_ENDING_TEXT[line.ending];
    }
    return contents;
  }
}
