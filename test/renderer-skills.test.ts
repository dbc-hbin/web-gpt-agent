import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { invokedSkills } from '../src/shared/skill-invocation.js';
import type { LibrarySkill, SkillLibrary } from '../src/shared/skills.js';
import { skillCompletion } from '../src/renderer/skills.js';
import type { ProjectDirectoryListing } from '../src/shared/project-files.js';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<textarea id="input"></textarea><details open><button id="skills" type="button">Skills</button><button id="add" type="button">+</button></details><div id="picker" hidden></div><div id="selected" hidden></div>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, Node: dom.window.Node });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => dom.window.close());
const skill: LibrarySkill = { id: 'review', name: 'Review', description: 'Check changes', path: '/skills/review/SKILL.md', managed: true, scope: 'managed', source: 'managed', allowImplicitInvocation: true };
const library = (skills = [skill]): SkillLibrary => ({ skills, errors: [], roots: [], includeInstructions: true });
async function fixture() {
  const { initSkills } = await import('../src/renderer/skills.js');
  const input = document.getElementById('input') as HTMLTextAreaElement;
  const button = document.getElementById('skills')!;
  const host = document.getElementById('picker')!;
  let owner = 'a:1';
  let projectId: string | null = 'project-a';
  const drafts = new Map<string, string>();
  const key = () => owner.split(':')[0]!;
  const list = vi.fn(async () => ({ ok: true as const, data: library() }));
  const listFiles = vi.fn(async (id: string, directory: string): Promise<ProjectDirectoryListing> => ({
    projectId: id, projectName: 'Project', directory,
    entries: directory ? [{ name: 'main.ts', path: `${directory}/main.ts`, kind: 'file', bytes: 20 }] : [
      { name: 'src', path: 'src', kind: 'directory', bytes: null },
      { name: 'README.md', path: 'README.md', kind: 'file', bytes: 20 }
    ], truncated: false
  }));
  const command = vi.fn();
  const picker = initSkills({ input, host, selectedHost: document.getElementById('selected')!, owner: () => owner,
    openButton: button, addButton: document.getElementById('add')!,
    scope: () => ({ sessionId: key(), projectId }), draft: () => drafts.get(key()), saveDraft: text => drafts.set(key(), text), list, listFiles });
  const type = (value: string) => { input.value = value; input.setSelectionRange(value.length, value.length); input.dispatchEvent(new Event('input')); };
  const press = (value: string) => picker.keydown(new dom.window.KeyboardEvent('keydown', { key: value, cancelable: true }));
  const replace = (value: string) => { drafts.set(key(), value); input.value = value; picker.restore(); };
  return { input, button, host, list, listFiles, command, picker, type, key: press, replace,
    project: (value: string | null) => { projectId = value; },
    owner: (value: string) => { owner = value; input.value = drafts.get(key()) ?? ''; picker.restore(); } };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

it('parses only leading commands, supports /prompt, and deduplicates without consuming prose', () => {
  expect(invokedSkills('/review\n/prompt audit\n/review\nDo this /other')).toEqual(['review', 'audit']);
  expect(invokedSkills('Do /review')).toEqual([]);
  expect(invokedSkills('```\n/review\n```')).toEqual([]);
  expect(invokedSkills('/project/file.md')).toEqual([]);
  expect(() => invokedSkills('/prompt')).toThrow(/Choose/);
});

it('keeps leading slash commands literal while offering safe file references', () => {
  expect(skillCompletion('/project/file.md', '/project/file.md'.length)).toBeNull();
  expect(skillCompletion('Use /review', 'Use /review'.length)).toBeNull();
  expect(skillCompletion('Use @src/ma', 'Use @src/ma'.length)).toMatchObject({ kind: 'file', directory: 'src', query: 'ma' });
  expect(skillCompletion('Contact @alice@example.com', 'Contact @alice@example.com'.length)).toBeNull();
  expect(skillCompletion('Read [file](@src', 'Read [file](@src'.length)).toBeNull();
});

it('offers file references after a closed fenced code block', () => {
  const text = '```\ncode\n```\nRead @src/ma';
  expect(skillCompletion(text, text.length)).toMatchObject({ kind: 'file', directory: 'src', query: 'ma' });
});

it('finds references in linear time after a long escaped prefix', () => {
  const pasted = 'x ' + '@\\ '.repeat(12_000) + 'x y';
  const startedAt = performance.now();
  expect(skillCompletion(pasted, pasted.length)).toBeNull();
  const reference = `${pasted}\nsee @src/ma`;
  expect(skillCompletion(reference, reference.length)).toMatchObject({ kind: 'file', directory: 'src', query: 'ma' });
  expect(performance.now() - startedAt).toBeLessThan(1000);
});

it('inserts project files and directories without changing the authored draft', async () => {
  const f = await fixture();
  f.type('Inspect @'); await settle();
  expect(f.listFiles).toHaveBeenLastCalledWith('project-a', '');
  (f.host.querySelector('[data-file-path="src"]') as HTMLButtonElement).click(); await settle();
  expect(f.input.value).toBe('Inspect @src/');
  expect(f.listFiles).toHaveBeenLastCalledWith('project-a', 'src');
  (f.host.querySelector('[data-file-path="src/main.ts"]') as HTMLButtonElement).click(); await settle();
  expect(f.input.value).toBe('Inspect @src/main.ts ');
  expect(f.picker.authoredText()).toBe('Inspect @src/main.ts ');
  expect(f.key('Enter')).toBe(false);
});

it('discards stale project listings after the composer changes projects', async () => {
  const f = await fixture();
  let resolveOld!: (listing: ProjectDirectoryListing) => void;
  f.listFiles.mockImplementationOnce((_id, _directory) => new Promise(resolve => { resolveOld = resolve; }));
  f.type('@');
  f.project('project-b'); f.type('@'); await settle();
  resolveOld({ projectId: 'project-a', projectName: 'Old project', directory: '', truncated: false,
    entries: [{ name: 'old.txt', path: 'old.txt', kind: 'file', bytes: 1 }] });
  await settle();
  expect(f.listFiles).toHaveBeenLastCalledWith('project-b', '');
  expect(f.host.querySelector('[data-file-path="old.txt"]')).toBeNull();
  expect(f.host.querySelector('[data-file-path="src"]')).not.toBeNull();
});

it('does not claim a truncated project listing is empty', async () => {
  const f = await fixture();
  f.listFiles.mockResolvedValueOnce({
    projectId: 'project-a', projectName: 'Project', directory: '', truncated: true,
    entries: [],
  });
  f.type('@'); await settle();
  expect(f.host.textContent).toContain('More files are not shown');
});

it('projects /prompt completion into chips while preserving the existing authored draft', async () => {
  const f = await fixture();
  f.type('/audit\n/prompt re'); await settle();
  expect(f.host.hidden).toBe(false);
  expect(f.key('Enter')).toBe(true);
  expect(f.input.value).toBe('');
  expect(invokedSkills(f.picker.authoredText())).toEqual(['audit', 'review']);
  expect(document.querySelectorAll('.composer-selected-skill')).toHaveLength(2);
  f.replace('/audit\nTask must stay exactly here');
  f.input.value = '/re\n' + f.input.value; f.input.setSelectionRange(3, 3); f.input.dispatchEvent(new Event('input')); await settle();
  (document.querySelector('[data-skill-id="review"].skill-choice') as HTMLButtonElement).click();
  expect(f.input.value).toBe('Task must stay exactly here');
  expect(f.picker.authoredText()).toBe('/audit\n/review\nTask must stay exactly here');
});

it('never traps Enter when loading, empty or unmatched and does not refetch on each character', async () => {
  const f = await fixture();
  let resolve!: (value: { ok: true; data: SkillLibrary }) => void;
  f.list.mockImplementation(() => new Promise(done => { resolve = done; }));
  f.type('/'); expect(f.key('Enter')).toBe(false);
  resolve({ ok: true, data: library([]) }); await settle();
  f.type('/z'); expect(f.key('Enter')).toBe(false);
  f.type('/zz'); expect(f.key('Enter')).toBe(false);
  expect(f.list).toHaveBeenCalledTimes(1);
});

it('does not apply stale choices after caret movement or a selection', async () => {
  const f = await fixture(); f.type('/re'); await settle();
  f.input.setSelectionRange(1, 2);
  expect(f.key('Enter')).toBe(false); expect(f.input.value).toBe('/re');
});
it('waits for committed IME composition before opening autocomplete', async () => {
  const f = await fixture();
  f.input.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
  f.input.value = '/re'; f.input.setSelectionRange(3, 3);
  f.input.dispatchEvent(new dom.window.InputEvent('input', { isComposing: true }));
  await settle(); expect(f.list).not.toHaveBeenCalled(); expect(f.host.hidden).toBe(true);
  f.input.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
  await settle(); expect(f.list).toHaveBeenCalledTimes(1); expect(f.host.hidden).toBe(false);
});

it('adds only the requested prompt from the popup and removes the slash-menu footer', async () => {
  const f = await fixture(); f.type('/'); await settle();
  expect(document.querySelector('dialog')).toBeNull();
  expect(f.host.querySelector('.skill-add, .skill-menu-footer')).toBeNull();
  const add = document.getElementById('add') as HTMLButtonElement;
  add.click();
  expect(f.input.value.split('\n')[0]).toContain('/skills');
  expect(f.input.value.split('\n')[0]).toMatch(/\b(?:add|import|install)\b/i);
  expect(f.host.hidden).toBe(true);
});
it('opens completion from the popup without losing draft text or selected skills', async () => {
  const f = await fixture();
  f.replace('/audit\nKeep this task');
  f.button.click(); await settle();
  expect(f.input.value).toBe('/\nKeep this task');
  expect(f.input.selectionStart).toBe(1);
  expect(document.activeElement).toBe(f.input);
  expect(document.querySelector('details')!.open).toBe(false);
  expect(f.host.hidden).toBe(false);
  expect(f.picker.authoredText()).toBe('/audit\n/\nKeep this task');
  expect(f.key('Enter')).toBe(true);
  expect(f.picker.authoredText()).toBe('/audit\n/review\nKeep this task');
  f.owner('b:2'); f.type('Other');
  (document.getElementById('add') as HTMLButtonElement).click();
  expect(f.input.value.split('\n')[0]).toContain('/skills');
  expect(f.input.value.split('\n')[0]).toMatch(/\b(?:add|import|install)\b/i);
  expect(f.input.value.split('\n').slice(1).join('\n')).toBe('Other');
  f.owner('a:3'); expect(f.picker.authoredText()).toBe('/audit\n/review\nKeep this task');
});

it('keeps chips in the existing per-chat draft through A to B to A and removes only the chosen directive', async () => {
  const f = await fixture();
  f.replace('/review\n/audit\nKeep my task exactly.\nProse /review stays literal.');
  f.owner('b:2'); f.type('Other chat');
  f.owner('a:3');
  expect(document.querySelectorAll('.composer-selected-skill')).toHaveLength(2);
  expect(f.input.value).toBe('Keep my task exactly.\nProse /review stays literal.');
  document.querySelector<HTMLButtonElement>('[data-skill-id="review"] .composer-selected-skill-remove')!.click();
  expect(f.picker.authoredText()).toBe('/audit\nKeep my task exactly.\nProse /review stays literal.');
  f.owner('b:4'); expect(f.picker.authoredText()).toBe('Other chat');
});

it('shows a failed library load and ignores a result for an old scope', async () => {
  const f = await fixture(); f.list.mockRejectedValueOnce(new Error('Disk is unavailable'));
  f.type('/'); await settle(); expect(f.host.textContent).toContain('Disk is unavailable');
  f.type(''); f.type('/re'); await settle(); expect(f.host.querySelector('[data-skill-id="review"]')).not.toBeNull();
  f.type('');
  let resolve!: (value: { ok: true; data: SkillLibrary }) => void;
  f.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.type('/'); f.owner('b:2'); f.type('B draft'); resolve({ ok: true, data: library() }); await settle();
  expect(f.picker.authoredText()).toBe('B draft'); expect(f.host.hidden).toBe(true);
});
