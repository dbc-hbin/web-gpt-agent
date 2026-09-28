/** Transport framing, not a second prompt source. Length keeps marker-like user text literal. */
export const MAX_CHATGPT_MESSAGE_CHARS = 96_000;
const continuation = (text: string): string => /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(text)?.[0] ?? '';
// New frames are emitted as CONTEXT; the legacy COS_CONTEXT name is still read from stored history.
const header = /^\[\[(COS_CONTEXT|CONTEXT):(\d{1,6})\]\]\n/;
export function userPromptText(text: string): string | null {
  text = text.replace(/\r\n?/g, '\n');
  const identity = continuation(text);
  const match = header.exec(text.slice(identity.length));
  if (!match) return null;
  const end = identity.length + match[0].length + Number(match[2]);
  const boundary = `\n[[/${match[1]}]]\n\n`;
  return text.startsWith(boundary, end) ? identity + text.slice(end + boundary.length) : null;
}

export function prependUserPrompt(text: string, instructions: string): string {
  text = text.replace(/\r\n?/g, '\n');
  instructions = instructions.replace(/\r\n?/g, '\n');
  const authored = userPromptText(text) ?? text;
  const identity = continuation(authored);
  return `${identity}[[CONTEXT:${instructions.length}]]\n${instructions}\n[[/CONTEXT]]\n\n${authored.slice(identity.length)}`;
}
