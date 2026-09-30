import { z } from 'zod';

const contentSchema = z.looseObject({ type: z.string(), text: z.string().optional() });
const resultSchema = z.looseObject({
  content: z.array(contentSchema),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional()
});

/** What a script actually receives from a nested call, wrapped so a thrown failure stays readable. */
const nativeSchema = z.looseObject({ __thrown: z.string() });

/**
 * Exercise the public exec boundary and report what the script saw.
 *
 * A nested call now returns the connector's own native value — a string, a structured object, `{}`
 * for a successful patch, or the raw `CallToolResult` of an external server — and a Core failure
 * arrives as a thrown `Error` rather than a returned `isError` envelope. The wrapper therefore
 * reports a thrown failure as `{__thrown}` so tests can distinguish "the tool refused" from "the
 * script failed", and leaves every other value exactly as the runtime produced it.
 *
 * `pragma` sets the outer cell's own `// @exec:` header. A nested `yield_time_ms` only bounds the
 * child tool; the cell itself still yields after its default observation window, so a caller that
 * must see a slow child's completion in this one reply sets the outer window here.
 */
export function codeModeCall(name: string, args: unknown, pragma?: { yield_time_ms?: number; max_output_tokens?: number }) {
  return { name: 'exec', arguments: { code:
    (pragma ? `// @exec: ${JSON.stringify(pragma)}\n` : '') +
    `let r;try{r=await tools[${JSON.stringify(name)}](${JSON.stringify(args)});}` +
    'catch(e){r={__thrown:String((e&&e.message)||e)};}' +
    'text(JSON.stringify(r));'
  } };
}

/**
 * The consumer-facing view of one nested result, reconstructed from the native value.
 *
 * This is the *test's* projection, never the wire contract: a raw MCP envelope is passed through
 * unchanged (external servers, Desktop and Plugins), a thrown Core failure becomes an `isError`
 * envelope carrying the tool's own message, and a Core native value becomes the envelope a caller of
 * that tool would have seen before code mode — text for a string, the structured object (and its JSON
 * text) for a machine-readable result, and no content at all for a successful patch.
 */
export function codeModeResult(value: unknown) {
  const outer = resultSchema.parse(value);
  if (outer.isError) return { result: outer, notices: [] };
  // The script's own emission is one text part among diagnostics (yield notices, truncation
  // markers), so the emitted value is the part that actually parses as JSON. A payload larger than
  // the text preview budget is clipped, and then the admitted prefix *is* what the wire carried:
  // the value is that text rather than a decode failure.
  const texts = outer.content.map((part, item) => ({ part, item })).filter(entry => entry.part.type === 'text' && entry.part.text !== undefined);
  let index = -1, emittedValue: unknown;
  for (const { part, item } of texts) {
    try { emittedValue = JSON.parse(part.text!); index = item; break; } catch { /* a diagnostic, not the emission */ }
  }
  if (index < 0 && texts.length > 0) { index = texts[0]!.item; emittedValue = texts[0]!.part.text; }
  if (index < 0) throw new Error('Code mode did not emit its nested result');
  const emitted = nativeSchema.safeParse(emittedValue);
  const native = emitted.success
    ? { content: [{ type: 'text', text: emitted.data.__thrown }], isError: true }
    : asEnvelope(emittedValue);
  native.content.push(...outer.content.filter(part => part.type === 'image'));
  const notices = outer.content.filter((part, item) => item !== index && part.type === 'text');
  return { result: native, notices };
}

function asEnvelope(value: unknown): z.infer<typeof resultSchema> {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { content?: unknown }).content)) {
    return resultSchema.parse(value);
  }
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  if (value === undefined || value === null) return { content: [] };
  const structured = value as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}
