import { messages } from './i18n-messages.js';
import { browserLanguageSource } from './i18n-browser-source.js';

export const locales = ['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'] as const;
export type Locale = typeof locales[number];
export const languageNames = ['繁體中文', 'English', '简体中文', '日本語', '한국어'];
export const languageStorageKey = 'forge-language';

export function resolveLocale(value: string | null | undefined): Locale | undefined {
  const tag = value?.toLowerCase().replaceAll('_', '-');
  if (!tag) return undefined;
  if (tag === 'zh' || /^zh-(hans|cn|sg)(-|$)/.test(tag)) return 'zh-Hans';
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(tag)) return 'zh-Hant';
  return locales.find(locale => tag === locale || tag.startsWith(locale + '-'));
}

export function translate(source: string, locale: Locale, values: Record<string, string | number> = {}): string {
  const row = messages[source];
  return (row?.[locales.indexOf(locale)] ?? source).replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}

// This function is also serialized for CSP-compatible plain HTML pages and the
// extension. Keep it self-contained; all data is passed explicitly.
export function installLanguage(catalog: Record<string, readonly string[]>, preferred?: string) {
  const codes = ['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'];
  const names = ['繁體中文', 'English', '简体中文', '日本語', '한국어'];
  const key = 'forge-language';
  const normalize = (value: string | null | undefined): string | undefined => {
    const tag = value?.toLowerCase().replaceAll('_', '-');
    if (!tag) return undefined;
    if (tag === 'zh' || /^zh-(hans|cn|sg)(-|$)/.test(tag)) return 'zh-Hans';
    if (/^zh-(hant|tw|hk|mo)(-|$)/.test(tag)) return 'zh-Hant';
    return codes.find(code => tag === code || tag.startsWith(code + '-'));
  };
  let saved: string | null = null;
  try { saved = localStorage.getItem(key); } catch { /* Sandboxed hosts may deny storage. */ }
  let language = normalize(preferred) ?? normalize(saved) ?? navigator.languages?.map(normalize).find(Boolean) ?? normalize(navigator.language) ?? 'en';
  const listeners = new Set<() => void>();
  const textNodes = new WeakMap<Text, string>();
  const aliases = new Map<string, readonly string[]>();
  const patterns: Array<{row: readonly string[], pattern: RegExp, fields: string[]}> = [];
  for (const row of new Set(Object.values(catalog))) {
    for (const copy of row) {
      aliases.set(copy, row);
      if (!copy.includes('{')) continue;
      const fields: string[] = [];
      const escaped = copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\w+)\\\}/g, (_, field: string) => { fields.push(field); return '([\\s\\S]+?)'; });
      patterns.push({row, pattern: new RegExp('^' + escaped + '$'), fields});
    }
  }
  const t = (source: string, values: Record<string, string | number> = {}): string => {
    let row = catalog[source] ?? aliases.get(source);
    if (!row) {
      for (const candidate of patterns) {
        const match = source.match(candidate.pattern);
        if (!match) continue;
        row = candidate.row;
        values = {...Object.fromEntries(candidate.fields.map((field, index) => [field, match[index + 1]])), ...values};
        break;
      }
    }
    if (!row && source.startsWith('Error: ')) return 'Error: ' + t(source.slice(7), values);
    if (!row && source.includes('\n')) return source.split('\n').map(line => t(line, values)).join('\n');
    if (!row) {
      for (const [prefix, candidate] of aliases) {
        if (/[:：]\s*$/.test(prefix) && source.startsWith(prefix)) return candidate[codes.indexOf(language)] + t(source.slice(prefix.length), values);
      }
    }
    return (row?.[codes.indexOf(language)] ?? source).replace(/\{(\w+)\}/g, (match, field: string) => String(values[field] ?? match));
  };
  const apply = () => {
    document.documentElement.lang = language;
    // Only explicitly marked product text is translated. Never inspect code,
    // paths, user input, tool payloads, or arbitrary document text.
    for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      for (const child of node.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE) continue;
        const text = child as Text;
        const source = textNodes.get(text) ?? text.data;
        textNodes.set(text, source);
        text.data = source.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, before: string, value: string, after: string) => before + t(value) + after);
      }
    }
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-' + attr + ']')) {
        node.setAttribute(attr, t(node.getAttribute('data-i18n-' + attr)!));
      }
    }
    for (const select of document.querySelectorAll<HTMLSelectElement>('[data-language-select]')) select.value = language;
    for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-message]')) node.textContent = t(node.dataset.i18nMessage!);
    for (const listener of listeners) listener();
  };
  const setLanguage = (value: string, persist = true) => {
    language = normalize(value) ?? 'en';
    if (persist) try { localStorage.setItem(key, language); } catch { /* Keep working in memory. */ }
    apply();
  };
  const mount = (parent: HTMLElement) => {
    const label = document.createElement('label');
    label.className = 'forge-language';
    label.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0;font:14px system-ui';
    const caption = document.createElement('span');
    caption.dataset.i18n = ''; caption.textContent = 'Language';
    const select = document.createElement('select');
    select.dataset.languageSelect = ''; select.dataset.i18nAriaLabel = 'Language';
    select.style.cssText = 'font:inherit;max-width:100%;padding:6px;border-radius:6px';
    codes.forEach((code, index) => { const option = document.createElement('option'); option.value = code; option.lang = code; option.textContent = names[index]; select.append(option); });
    select.value = language;
    select.onchange = () => setLanguage(select.value);
    label.append(caption, select); parent.prepend(label); apply();
    return select;
  };
  window.addEventListener('storage', event => { if (event.key === key && normalize(event.newValue)) setLanguage(event.newValue!, false); });
  apply();
  return { t, mount, apply, setLanguage, get language() { return language; }, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } };
}

export function languageScript(): string {
  // Escape HTML delimiters so source strings cannot terminate inline scripts.
  return `const forgeLanguage=(${browserLanguageSource})(${JSON.stringify(messages).replaceAll('<', '\\u003c')});forgeLanguage.mount(document.querySelector('header')||document.querySelector('main')||document.body);`;
}

/** Mark only known static product copy, preserving nested links and controls. */
export function markLocalizedHtml(html: string): string {
  return html.replace(/<([a-z][\w-]*)(\s[^<>]*?)?>([^<>]*)/gi, (match, tag: string, attrs = '', text: string) => {
    if (['script', 'style', 'code'].includes(tag.toLowerCase()) || attrs.includes('data-no-i18n')) return match;
    const marked = messages[text.trim()] ? ' data-i18n' : '';
    const attributes = attrs.replace(/\b(title|placeholder|aria-label)="([^"]*)"/g, (original: string, name: string, value: string) => messages[value] ? `${original} data-i18n-${name}="${value}"` : original);
    if (['input', 'br', 'hr', 'img'].includes(tag.toLowerCase())) return `<${tag}${attributes}>${marked ? '<span data-i18n>' + text + '</span>' : text}`;
    return `<${tag}${attributes}${marked}>${text}`;
  }).replace(/(<\/[a-z][\w-]*>)([^<>]+)/gi, (match, close: string, text: string) => messages[text.trim()] ? `${close}<span data-i18n>${text}</span>` : match);
}
