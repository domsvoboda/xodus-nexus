import type { TranslationCatalog } from './interface-language.js';

/** Presentation adapter for existing English IPC messages. Protocol values,
 * persisted task states and diagnostics themselves remain unchanged. */
export function messageTranslator(english: TranslationCatalog, translate: (key: string, values?: Record<string, string | number>) => string) {
  const exact = new Map(Object.entries(english).filter(([, text]) => !text.includes('{{')).map(([key, text]) => [text, key]));
  const templates = Object.entries(english).filter(([, text]) => text.includes('{{')).map(([key, text]) => {
    const names: string[] = [];
    const escaped = text.split(/(\{\{[a-zA-Z][a-zA-Z0-9_]*\}\})/).map(part => {
      if (part.startsWith('{{') && part.endsWith('}}')) { names.push(part.slice(2, -2)); return '(.+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { key, names, pattern: new RegExp(`^${escaped}$`) };
  });
  return (text: string): string => {
    if (!text || text.length > 12000 || /[\r\n]/.test(text)) return text;
    const normalized = text.replaceAll('\u2014', ',');
    const key = exact.get(normalized);
    if (key) return translate(key);
    for (const template of templates) {
      const match = template.pattern.exec(normalized);
      if (match) return translate(template.key, Object.fromEntries(template.names.map((name, index) => [name, match[index + 1]])));
    }
    return text;
  };
}
