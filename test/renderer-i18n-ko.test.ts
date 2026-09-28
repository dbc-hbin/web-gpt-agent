import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import es from '../src/renderer/locales/es.json';
import zhCN from '../src/renderer/locales/zh-CN.json';
import zhTW from '../src/renderer/locales/zh-TW.json';
import ja from '../src/renderer/locales/ja.json';
import ko from '../src/renderer/locales/ko.json';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

describe('Korean app interface', () => {
  it('covers every existing source key with matching placeholders', () => {
    const others = [es, zhCN, zhTW, ja].flatMap(catalog => Object.keys(catalog));
    expect([...new Set(others)].filter(source => !Object.hasOwn(ko, source))).toEqual([]);
    for (const [source, translation] of Object.entries(ko)) {
      expect(translation.trim(), source).not.toBe('');
      const args = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
      expect(args(translation), source).toEqual(args(source));
    }
  });

  it('restores Korean and keeps the setup flags, settings select and saved preference in sync', async () => {
    window.localStorage.setItem('cos.ui.language', 'ko');
    const { initLanguage, currentLanguage } = await import('../src/renderer/i18n.js');
    initLanguage();
    const select = document.getElementById('uiLanguage') as HTMLSelectElement;
    const button = document.querySelector<HTMLButtonElement>('[data-language="ko"]')!;
    expect(currentLanguage()).toBe('ko');
    expect(document.documentElement.lang).toBe('ko');
    expect(document.querySelector('.setup-heading h1')!.textContent).toBe(ko['Setup']);
    expect(select.value).toBe('ko');
    expect(select.selectedOptions[0]!.lang).toBe('ko');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    select.value = 'en';
    select.dispatchEvent(new dom.window.Event('change'));
    expect(currentLanguage()).toBe('en');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(select.value).toBe('ko');
    expect(window.localStorage.getItem('cos.ui.language')).toBe('ko');
    vi.resetModules();
    const reloaded = await import('../src/renderer/i18n.js');
    expect(reloaded.currentLanguage()).toBe('ko');
    expect(reloaded.t('Settings')).toBe(ko['Settings']);
  });

  it('keeps drafts, focus, provider text, code and literal arguments while Korean labels refresh', async () => {
    const { initLanguage, setLanguage, t, ui, uiText } = await import('../src/renderer/i18n.js');
    initLanguage();
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    const draft = '/review\n한국어 초안 🙂 <script>literal</script>';
    input.value = draft; input.focus(); input.setSelectionRange(2, 8);
    const authored = document.createElement('p'); authored.textContent = 'Settings';
    const native = document.createElement('span');
    native.setAttribute('translate', 'no'); native.textContent = 'Save'; native.title = 'Settings';
    const code = document.createElement('code'); code.textContent = 'Settings';
    const hidden = document.createElement('div'); hidden.hidden = true;
    const label = uiText(() => t('Settings')); hidden.append(label);
    const argument = '$& /자료/Save <img src=x>';
    const action = ui(document.createElement('button'), 'textContent', () => t('Remove {0}', [argument]));
    document.body.append(authored, native, code, hidden, action);
    const icons = [...document.querySelectorAll('svg')];
    for (const locale of ['ko', 'en', 'ko'] as const) {
      setLanguage(locale);
      expect(document.getElementById('chatInput')).toBe(input);
      expect(input.value).toBe(draft);
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
      expect(document.activeElement).toBe(input);
      expect([...document.querySelectorAll('svg')]).toEqual(icons);
      expect(authored.textContent).toBe('Settings');
      expect(code.textContent).toBe('Settings');
      expect([native.textContent, native.title]).toEqual(['Save', 'Settings']);
      expect(action.querySelector('img')).toBeNull();
    }
    expect(label.textContent).toBe(ko['Settings']);
    expect(action.textContent).toBe(ko['Remove {0}'].replace('{0}', () => argument));
    expect(t('unknown source {0}', [argument])).toBe(`unknown source ${argument}`);
    for (const source of ['__proto__', 'toString', 'exec_command', 'gpt-6-astra']) expect(t(source)).toBe(source);
  });

  it('falls back to English for invalid saved data and still selects Korean when storage fails', async () => {
    window.localStorage.setItem('cos.ui.language', 'invalid');
    expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('en');
    vi.resetModules();
    vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
    vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    const { initLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
    initLanguage();
    document.querySelector<HTMLButtonElement>('[data-language="ko"]')!.click();
    expect(currentLanguage()).toBe('ko');
    expect(document.documentElement.lang).toBe('ko');
    expect((document.getElementById('uiLanguage') as HTMLSelectElement).value).toBe('ko');
    expect(t('Settings')).toBe(ko['Settings']);
  });
});
