import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createApi, fromTolgee, pages, tokens, viewRoute } from './tolgee-accept.mjs';
import { parseCatalog } from './localization.mjs';

const project = '/v2/projects/36162';
const root = fileURLToPath(new URL('../', import.meta.url));
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const planDigest = plan => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const toTolgee = text => text.replace(/'/g, "''").replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, '{$1}');

export function validatePlan(plan, english) {
  if (!Array.isArray(plan) || !plan.length || plan.length > 1000) throw Error('Expected 1 to 1000 reviewed selections.');
  const seen = new Set();
  for (const entry of plan) {
    const { language, key, source, suggestion, translation, previous, previousState } = entry;
    if (typeof language !== 'string' || /^en(?:-|$)/i.test(language) || Intl.getCanonicalLocales(language)[0] !== language ||
        !Object.hasOwn(english, key) || source !== english[key] || seen.has(`${language}:${key}`)) throw Error('Invalid language, source or duplicate selection.');
    if (typeof suggestion !== 'string' || !suggestion.length || suggestion.length > 12000 ||
        previous !== null && typeof previous !== 'string' || !['UNTRANSLATED', 'TRANSLATED', 'REVIEWED'].includes(previousState)) throw Error('Invalid selection snapshot.');
    if (entry.existing !== undefined && entry.existing !== true || entry.existing &&
        (previousState === 'UNTRANSLATED' || previous !== suggestion)) throw Error('Existing translation review requires an exact nonempty snapshot.');
    parseCatalog(JSON.stringify({ [key]: translation }), english);
    if (!same(tokens(source), tokens(translation)) || translation.normalize('NFC') !== translation ||
        /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u.test(translation)) throw Error('Unsafe reviewed translation.');
    // Preserve intentional UI spacing from the English source, not arbitrary padding.
    if (translation.match(/^\s*/u)[0] !== source.match(/^\s*/u)[0] || translation.match(/\s*$/u)[0] !== source.match(/\s*$/u)[0]) throw Error('Reviewed spacing differs from source.');
    seen.add(`${language}:${key}`);
  }
}

function selection(row, language, entry) {
  const cell = row?.translations?.[entry.language];
  if (!positive(row?.keyId) || row.keyName !== entry.key || row.keyNamespace || row.branch != null && row.branch !== 'main' ||
      row.keyIsPlural !== false || fromTolgee(row.translations?.en?.text) !== entry.source || !cell ||
      cell.id != null && !positive(cell.id) || cell.state !== 'UNTRANSLATED' && !positive(cell.id) ||
      cell.unresolvedCommentCount !== 0 || (cell.qaIssueCount ?? 0) !== 0 || cell.outdated !== false ||
      cell.text !== entry.previous || cell.state !== entry.previousState) throw Error(`Selection changed or needs discussion: ${entry.language}:${entry.key}`);
  if (entry.existing) return undefined;
  const matches = cell.suggestions?.filter(value => value.state === 'ACTIVE' && value.translation === entry.suggestion && value.isPlural === false);
  // TranslationView embeds TranslationSuggestionSimpleModel: parent key/language
  // provide its context. The accept receipt is the full model and must prove IDs.
  if (matches?.length !== 1 || !positive(matches[0].id) ||
      matches[0].languageId !== undefined && matches[0].languageId !== language.id ||
      matches[0].keyId !== undefined && matches[0].keyId !== row.keyId) throw Error(`Selected suggestion is missing or ambiguous: ${entry.language}:${entry.key}`);
  return matches[0];
}

/** Explicit maintainer selections, never a less strict automatic acceptance mode. */
export async function reviewPlan({ api, english, plan, digest, apply = false, report = {} }) {
  validatePlan(plan, english);
  if (digest !== planDigest(plan)) throw Error('The reviewed plan digest is required.');
  Object.assign(report, { project: 36162, mode: apply ? 'apply-reviewed-plan' : 'preview-reviewed-plan', digest, accepted: 0, corrected: 0, reviewed: 0, entries: [] });
  const languages = await pages(api, `${project}/languages`, 'languages', 200);
  if (languages.filter(value => value.base).length !== 1 || !languages.some(value => value.base && value.tag === 'en')) throw Error('Unexpected base language.');
  const targets = [...new Set(plan.map(entry => entry.language))];
  const rows = await pages(api, viewRoute(['en', ...targets]), 'keys', 10000);
  const selected = plan.map(entry => {
    const language = languages.find(value => value.tag === entry.language && !value.base);
    if (!language || !positive(language.id)) throw Error('Unknown target language.');
    const row = rows.find(value => value.keyName === entry.key && !value.keyNamespace && (value.branch == null || value.branch === 'main'));
    return { entry, language, row, suggestion: selection(row, language, entry) };
  });
  // Validate the entire plan before any mutation, then refresh bounded batches.
  for (let start = 0; start < selected.length; start += 20) {
    const batch = selected.slice(start, start + 20);
    const tags = ['en', ...new Set(batch.map(item => item.entry.language))];
    const keys = [...new Set(batch.map(item => item.row.keyId))];
    const fresh = await pages(api, viewRoute(tags, keys), 'keys', keys.length);
    for (const item of batch) {
      const current = fresh.find(value => value.keyId === item.row.keyId);
      const next = selection(current, item.language, item.entry);
      if (next?.id !== item.suggestion?.id) throw Error('Selected suggestion changed.');
    }
    for (const { entry, language, row, suggestion } of batch) {
      const result = { language: entry.language, key: entry.key, status: 'selected' }; report.entries.push(result);
      if (!apply) continue;
      if (!entry.existing) {
        result.status = 'accept-outcome-unknown';
        const receipt = await api(`${project}/languages/${language.id}/key/${row.keyId}/suggestion/${suggestion.id}/accept?declineOther=false`, 'PUT');
        if (receipt.accepted?.id !== suggestion.id || receipt.accepted.languageId !== language.id || receipt.accepted.keyId !== row.keyId ||
            receipt.accepted.state !== 'ACCEPTED' || receipt.accepted.translation !== entry.suggestion || !same(receipt.declined, [])) throw Error('Unexpected acceptance receipt. No retries.');
        report.accepted++; result.status = 'accepted';
      } else result.status = 'matched-existing';
      if (fromTolgee(entry.suggestion) !== entry.translation) {
        result.status = 'correction-outcome-unknown';
        // The view labels the default branch "main" even when the project's
        // paid branching feature is disabled. Omit the optional branch selector.
        const updated = await api(`${project}/translations`, 'PUT', { key: entry.key, namespace: null,
          translations: { [entry.language]: toTolgee(entry.translation) } });
        if (updated.keyId !== row.keyId || updated.keyName !== entry.key || updated.keyNamespace || updated.keyIsPlural !== false ||
            fromTolgee(updated.translations?.[entry.language]?.text) !== entry.translation) throw Error('Correction could not be verified. No retries.');
        report.corrected++; result.status = 'corrected';
      }
    }
    if (!apply) continue;
    const after = await pages(api, viewRoute(tags, keys), 'keys', keys.length);
    for (const { entry, row } of batch) {
      const current = after.find(value => value.keyId === row.keyId), cell = current?.translations?.[entry.language];
      if (current?.keyName !== entry.key || current.keyNamespace || current.branch !== row.branch || fromTolgee(current.translations?.en?.text) !== entry.source ||
          !positive(cell?.id) || fromTolgee(cell.text) !== entry.translation || cell.outdated !== false || cell.unresolvedCommentCount !== 0 || (cell.qaIssueCount ?? 0) !== 0) throw Error('Translation changed or is flagged after acceptance.');
      const result = report.entries.find(value => value.language === entry.language && value.key === entry.key);
      result.status = 'review-outcome-unknown';
      const state = await api(`${project}/translations/${cell.id}/set-state/REVIEWED`, 'PUT');
      if (state.id !== cell.id || fromTolgee(state.text) !== entry.translation || state.state !== 'REVIEWED' || state.outdated !== false) throw Error('Reviewed state could not be verified.');
      report.reviewed++; result.status = 'reviewed';
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = {};
  try {
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 2 || !/^[a-f0-9]{64}$/.test(args[0]) || args.length === 2 && args[1] !== '--apply') throw Error('Usage: tolgee-review-plan.mjs <reviewed-plan-sha256> [--apply]');
    const plan = JSON.parse(await fs.readFile(path.join(root, '.github/translations/review-plan.json'), 'utf8'));
    const english = parseCatalog(await fs.readFile(path.join(root, 'assets/locales/en.json'), 'utf8'));
    await reviewPlan({ api: createApi(process.env.TOLGEE_REVIEW_API_KEY, fetch, pause, 200), english, plan, digest: args[0], apply: args[1] === '--apply', report });
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally { console.log(JSON.stringify(report, null, 2)); }
}
