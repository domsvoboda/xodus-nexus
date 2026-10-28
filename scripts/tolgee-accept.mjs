import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { parseCatalog } from './localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = '/v2/projects/36162';
const own = (object, key) => Object.hasOwn(object ?? {}, key);
const id = value => Number.isSafeInteger(value) && value > 0;
const canonical = value => {
  try { return typeof value === 'string' && Intl.getCanonicalLocales(value)[0] === value; } catch { return false; }
};

/** Only the plain-text subset exported by our i18next source importer is supported.
 * Complex ICU/plural/quoted brace expressions require a person, not a guessed conversion. */
export function fromTolgee(text) {
  if (typeof text !== 'string' || text.length > 12000 || /\{\{|\}\}|'[{}#]/.test(text)) throw Error('unsupported-syntax');
  const result = text.replace(/''/g, "'").replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, '{{$1}}');
  parseCatalog(JSON.stringify({ value: result }));
  return result;
}

function tokens(text) {
  return (text.match(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}|https?:\/\/[^\s<>]+|`[^`]+`|\b(?:Xbox|Microsoft|Xodus|Nexus|Tolgee|Steam)\b|--[a-z][a-z0-9-]*/g) ?? []).sort();
}

function scriptMatches(text, tag) {
  const plain = text.replace(/\{\{[^}]+\}\}|https?:\/\/\S+|`[^`]+`/g, '');
  if (!/\p{L}/u.test(plain)) return false;
  const language = tag.split('-')[0];
  const expected = { ar: /\p{Script=Arabic}/u, ru: /\p{Script=Cyrillic}/u, uk: /\p{Script=Cyrillic}/u,
    ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, ko: /\p{Script=Hangul}/u,
    zh: /\p{Script=Han}/u, el: /\p{Script=Greek}/u }[language];
  if (expected) return expected.test(plain);
  // Do not pretend a script check can distinguish e.g. French from Spanish.
  if (['cs', 'sk', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'hu', 'tr', 'pl'].includes(language)) {
    return /\p{Script=Latin}/u.test(plain) && !/[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Han}\p{Script=Hangul}]/u.test(plain);
  }
  return false;
}

/** A technical policy, not a claim that wording or meaning has been reviewed. */
export function assess(row, language, english) {
  const cell = row.translations?.[language.tag];
  const result = reason => ({ reason });
  if (language.base || /^en(?:-|$)/i.test(language.tag)) return result('protected-source');
  if (!id(row.keyId) || !own(english, row.keyName)) return result('unknown-key');
  if (row.keyNamespace) return result('nondefault-namespace');
  // Tolgee creates a main branch even before branching is enabled. The unfiltered
  // list endpoint returns only default-branch or legacy branchless keys. ID lookups
  // bypass that server filter, so retain this allowlist and compare snapshots below.
  if (row.branch != null && row.branch !== 'main') return result('unsupported-branch');
  if (row.keyIsPlural !== false) return result('plural-needs-review');
  if (!cell || cell.text != null && cell.text !== '' || cell.state !== 'UNTRANSLATED') return result('existing-translation');
  if (cell.outdated !== false || cell.unresolvedCommentCount !== 0 || (cell.qaIssueCount ?? 0) !== 0) return result('flagged-translation');
  if (cell.activeSuggestionCount !== 1) return result('competing-suggestions');
  const suggestions = cell.suggestions?.filter(value => value.state === 'ACTIVE');
  if (suggestions?.length !== 1 || !id(suggestions[0].id) || suggestions[0].isPlural !== false) return result('incomplete-suggestion');
  const suggestion = suggestions[0];
  let source, translated;
  try {
    source = fromTolgee(row.translations.en?.text);
    translated = fromTolgee(suggestion.translation);
    parseCatalog(JSON.stringify({ [row.keyName]: translated }), english);
  } catch { return result('invalid-text-or-parameters'); }
  if (source !== english[row.keyName]) return result('source-not-synchronized');
  if (JSON.stringify(tokens(source)) !== JSON.stringify(tokens(translated))) return result('changed-protected-token');
  if (translated.trim() !== translated || translated.normalize('NFC') !== translated || /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u.test(translated)) return result('suspicious-format');
  if (translated === source || !scriptMatches(translated, language.tag)) return result('language-needs-review');
  if (translated.length > Math.max(160, source.length * 4) || source.length > 80 && translated.length < source.length / 5) return result('suspicious-length');
  if (Number.isInteger(row.keyMaxCharLimit) && row.keyMaxCharLimit > 0 && translated.length > row.keyMaxCharLimit) return result('character-limit');
  return { reason: 'eligible', suggestion, translated };
}

/** Never follow response-provided links, redirects, or print response bodies/tokens. */
export function createApi(key, fetcher = fetch, wait = pause, interval = 0) {
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw Error('Set TOLGEE_REVIEW_API_KEY to a project-scoped review key.');
  let lastRequest = 0;
  return async (route, method = 'GET') => {
    if (!route.startsWith(`${project}/`) || route.includes('..') || /[\\#\r\n]/.test(route) || !['GET', 'PUT'].includes(method)) throw Error('Invalid API operation.');
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      const spacing = interval - (Date.now() - lastRequest);
      if (spacing > 0) await wait(spacing);
      lastRequest = Date.now();
      try {
        response = await fetcher(`https://app.tolgee.io${route}`, {
          method, headers: { 'X-API-Key': key, accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(15000),
        });
      } catch { throw Error(`Tolgee ${method} transport failed. No automatic retry; check the report before rerunning.`); }
      if (method !== 'GET' || response.status !== 429 || attempt === 2) break;
      const header = response.headers.get('retry-after');
      // Tolgee's documented translation-view window is five minutes. A missing
      // header must not cause repeated one-minute requests inside the same window.
      const delay = header === null ? 301000 : /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
      await response.body?.cancel();
      if (!Number.isFinite(delay) || delay > 360000) throw Error('Tolgee read rate limit requires a later attempt. No writes retried.');
      const milliseconds = Math.max(1000, delay);
      console.error(`Tolgee read rate limited; waiting ${Math.ceil(milliseconds / 1000)} seconds.`);
      await wait(milliseconds);
    }
    if (!response.ok) { await response.body?.cancel(); throw Error(`Tolgee ${method} failed (HTTP ${response.status}). No automatic retry.`); }
    const reader = response.body?.getReader();
    if (!reader) throw Error('Missing Tolgee response.');
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw Error('Response too large.'); }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw Error('Invalid or oversized Tolgee response. No automatic retry.'); }
  };
}

async function pages(api, route, collection, limit) {
  const all = []; const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const value = await api(`${route}${route.includes('?') ? '&' : '?'}size=100&page=${page}`);
    const rows = value._embedded?.[collection] ?? (value.page?.totalElements === 0 ? [] : undefined);
    if (!Array.isArray(rows) || !Number.isInteger(value.page?.totalPages) || value.page.totalPages < 0 || value.page.totalPages > 100 || value.page.number !== page) throw Error('Invalid Tolgee pagination.');
    for (const row of rows) {
      const identity = collection === 'keys' ? row.keyId : row.id;
      if (!id(identity) || seen.has(identity) || all.length >= limit) throw Error('Duplicate or excessive Tolgee records.');
      seen.add(identity); all.push(row);
    }
    if (page + 1 >= value.page.totalPages) return all;
    if (!rows.length) throw Error('Incomplete Tolgee pagination.');
  }
  throw Error('Too many Tolgee pages.');
}

function viewRoute(tags, keyId) {
  const query = new URLSearchParams();
  for (const tag of tags) query.append('languages', tag);
  query.set('sort', 'keyId,asc');
  if (keyId) for (const value of Array.isArray(keyId) ? keyId : [keyId]) query.append('filterKeyId', String(value));
  return `${project}/translations?${query}`;
}

export async function acceptSuggestions({ api, english, apply = false, reviewed = false, tags = [], report = {}, texts = false, exclude = [], reviewDigest }) {
  if (reviewed && !apply) throw Error('Reviewed mode requires explicit apply.');
  if (texts && apply) throw Error('Text snapshots are preview-only.');
  if (reviewDigest !== undefined && !/^[a-f0-9]{64}$/.test(reviewDigest)) throw Error('Invalid review digest.');
  Object.assign(report, { project: 36162, mode: apply ? reviewed ? 'accept-and-review' : 'accept' : 'preview',
    linguisticReview: false, entries: [], accepted: 0, reviewed: 0 });
  const languages = await pages(api, `${project}/languages`, 'languages', 200);
  if (languages.filter(value => value.base).length !== 1 || !languages.find(value => value.base && value.tag === 'en') ||
      languages.some(value => !canonical(value.tag)) || new Set(languages.map(value => value.tag)).size !== languages.length) throw Error('Unexpected project languages or base language.');
  for (const tag of tags) if (!canonical(tag) || /^en(?:-|$)/i.test(tag) || !languages.some(value => value.tag === tag)) throw Error('Invalid target language.');
  const targets = languages.filter(value => !value.base && !/^en(?:-|$)/i.test(value.tag) && (!tags.length || tags.includes(value.tag)));
  if (!targets.length) throw Error('No target languages selected.');
  for (const value of exclude) {
    const [tag, key, extra] = value.split(':');
    if (extra !== undefined || !targets.some(language => language.tag === tag) || !own(english, key)) throw Error('Invalid review exclusion.');
  }
  // Snapshot all pages before mutation, never paginate a shrinking suggestion filter.
  const rows = await pages(api, viewRoute(['en', ...targets.map(value => value.tag)]), 'keys', 10000);
  const pending = [];
  for (const row of rows) for (const language of targets) {
    const cell = row.translations?.[language.tag];
    if (!cell?.activeSuggestionCount) continue;
    const decision = assess(row, language, english);
    const entry = { key: own(english, row.keyName) ? row.keyName : '(unknown)', language: language.tag, status: decision.reason };
    report.entries.push(entry);
    if (decision.reason === 'eligible') pending.push({ row, language, decision, entry });
  }
  const snapshot = pending.map(({ row, language, decision }) => ({ language: language.tag, key: row.keyName,
    source: english[row.keyName], translation: decision.translated }))
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  report.reviewDigest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  if (texts) {
    report.reviewSnapshot = snapshot;
    // Public UI text only, never suggestion/contributor/account identifiers.
    // Include blocked candidates so a maintainer can review conflicts and typos
    // without weakening the automatic acceptance policy.
    report.suggestionSnapshot = rows.flatMap(row => targets.flatMap(language => {
      const cell = row.translations?.[language.tag];
      if (!cell?.activeSuggestionCount) return [];
      return [{ language: language.tag, key: row.keyName,
        source: row.translations.en?.text, current: cell.text, state: cell.state,
        reason: assess(row, language, english).reason,
        suggestions: (cell.suggestions ?? []).filter(value => value.state === 'ACTIVE')
          .map(value => ({ text: value.translation, plural: value.isPlural })) }];
    }));
  }
  if (reviewDigest !== undefined && report.reviewDigest !== reviewDigest) throw Error('Suggestions changed since the language review. No writes performed.');
  const excluded = new Set(exclude);
  for (const { language, row, entry } of pending) if (excluded.has(`${language.tag}:${row.keyName}`)) entry.status = 'excluded-by-language-review';
  if (!apply) return report;
  const selected = pending.filter(value => value.entry.status !== 'excluded-by-language-review');
  // Use Tolgee's supported multi-key view filter. Two views per twenty entries,
  // rather than two per entry, stay below its 100-views/five-minute limit.
  // There is no server CAS: do not edit these keys concurrently with the batch.
  for (let start = 0; start < selected.length; start += 20) {
    const batch = selected.slice(start, start + 20);
    const keys = [...new Set(batch.map(value => value.row.keyId))];
    const tags = ['en', ...new Set(batch.map(value => value.language.tag))];
    const fresh = await pages(api, viewRoute(tags, keys), 'keys', keys.length);
    const freshById = new Map(fresh.map(value => [value.keyId, value]));
    const acceptedBatch = [];
    for (const item of batch) {
      const { row, language, decision, entry } = item;
      const current = freshById.get(row.keyId);
      const next = current ? assess(current, language, english) : {};
      if (current?.keyName !== row.keyName || current?.keyNamespace !== row.keyNamespace || current?.branch !== row.branch || next.reason !== 'eligible' || next.suggestion.id !== decision.suggestion.id || next.suggestion.translation !== decision.suggestion.translation) {
        entry.status = 'changed-before-accept'; continue;
      }
      const route = `${project}/languages/${language.id}/key/${row.keyId}/suggestion`;
      entry.status = 'accept-outcome-unknown';
      const receipt = await api(`${route}/${decision.suggestion.id}/accept?declineOther=false`, 'PUT');
      const accepted = receipt.accepted;
      if (accepted?.id !== decision.suggestion.id || accepted.languageId !== language.id || accepted.keyId !== row.keyId || accepted.state !== 'ACCEPTED' || accepted.translation !== decision.suggestion.translation || !Array.isArray(receipt.declined) || receipt.declined.length) throw Error('Unexpected acceptance receipt; stopped without retry.');
      report.accepted++; entry.status = 'accepted'; acceptedBatch.push(item);
    }
    if (!acceptedBatch.length) continue;
    const after = await pages(api, viewRoute(tags, keys), 'keys', keys.length);
    const afterById = new Map(after.map(value => [value.keyId, value]));
    for (const { row, language, decision, entry } of acceptedBatch) {
      const current = afterById.get(row.keyId);
      const target = current?.translations?.[language.tag];
      if (current?.keyName !== row.keyName || current?.branch !== row.branch || current?.keyNamespace !== row.keyNamespace || fromTolgee(current?.translations?.en?.text) !== english[row.keyName] || target?.text !== decision.suggestion.translation || !id(target?.id) || target.outdated !== false) throw Error('Accepted translation could not be verified; stopped.');
      if (reviewed) {
        entry.status = 'accepted-review-outcome-unknown';
        const state = await api(`${project}/translations/${target.id}/set-state/REVIEWED`, 'PUT');
        if (state.id !== target.id || state.text !== decision.suggestion.translation || state.state !== 'REVIEWED' || state.outdated !== false) throw Error('Reviewed translation could not be verified; stopped.');
        entry.status = 'accepted-and-reviewed'; report.reviewed++;
        if (report.reviewed % 25 === 0) console.error(`${report.reviewed} translations accepted and reviewed in this run.`);
      }
    }
  }
  return report;
}

export function argumentsFor(argv) {
  const result = { apply: false, reviewed: false, tags: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (seen.has(option)) throw Error('Duplicate option.');
    seen.add(option);
    if (option === '--apply') result.apply = true;
    else if (option === '--reviewed') result.reviewed = true;
    else if (option === '--texts') result.texts = true;
    else if (option === '--review-digest') {
      result.reviewDigest = argv[++index];
      if (!/^[a-f0-9]{64}$/.test(result.reviewDigest ?? '')) throw Error('Invalid review digest.');
    } else if (option === '--exclude') {
      result.exclude = (argv[++index] ?? '').split(',');
      if (!result.exclude.every(value => /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*:[a-z][a-zA-Z0-9_.]*$/.test(value))) throw Error('Invalid review exclusions.');
    }
    else if (option === '--languages') {
      result.tags = (argv[++index] ?? '').split(',');
      if (!result.tags.every(canonical) || new Set(result.tags).size !== result.tags.length) throw Error('Invalid languages.');
    } else throw Error('Usage: npm run i18n:accept -- [--languages fr,es] [--apply [--reviewed]]');
  }
  if (result.reviewed && !result.apply) throw Error('--reviewed requires --apply.');
  if (result.texts && result.apply) throw Error('--texts is preview-only.');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = {};
  try {
    const options = argumentsFor(process.argv.slice(2));
    const english = parseCatalog(await fs.readFile(path.join(root, 'assets/locales/en.json'), 'utf8'));
    await acceptSuggestions({ ...options, english, report, api: createApi(process.env.TOLGEE_REVIEW_API_KEY, fetch, pause, 200) });
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}
