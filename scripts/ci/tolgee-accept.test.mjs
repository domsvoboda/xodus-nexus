import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { acceptSuggestions, assess, argumentsFor, createApi, fromTolgee } from '../tolgee-accept.mjs';

const english = { 'common.cancel_game': 'Cancel {{game}}?', 'auth.browser': 'Continue in browser', help: "Your account's Xbox profile is ready." };
const languages = [{ id: 1, tag: 'en', base: true }, { id: 2, tag: 'fr', base: false }, { id: 3, tag: 'es', base: false }];
const suggestion = () => ({ id: 40, languageId: 2, keyId: 10, translation: 'Annuler {game} ?', isPlural: false, state: 'ACTIVE' });
const cell = () => ({ id: 20, text: null, state: 'UNTRANSLATED', outdated: false, unresolvedCommentCount: 0, qaIssueCount: 0,
  activeSuggestionCount: 1, suggestions: [suggestion()] });
const row = () => ({ keyId: 10, keyName: 'common.cancel_game', keyIsPlural: false, keyNamespace: null, branch: 'main',
  translations: { en: { text: 'Cancel {game}?' }, fr: cell(), es: { ...cell(), activeSuggestionCount: 0, suggestions: [] } } });
const page = (collection, rows, number = 0, totalPages = 1) => ({ _embedded: { [collection]: rows }, page: { number, totalPages, totalElements: rows.length } });
const clone = value => structuredClone(value);

function fixture(options = {}) {
  const current = row(); const calls = []; let viewReads = 0;
  const handler = async (route, method = 'GET') => {
    calls.push({ route, method });
    const url = new URL(`https://app.tolgee.io${route}`);
    const stem = '/v2/projects/36162';
    if (url.pathname === `${stem}/languages`) return page('languages', clone(options.languages ?? languages));
    if (url.pathname === `${stem}/translations`) {
      viewReads++;
      options.beforeView?.(current, viewReads);
      return page('keys', [clone(current)]);
    }
    if (url.pathname === `${stem}/languages/2/key/10/suggestion`) {
      throw Error('Separate suggestion listing requires unnecessary suggest/manage permissions.');
    }
    if (url.pathname === `${stem}/languages/2/key/10/suggestion/40/accept`) {
      assert.equal(method, 'PUT');
      assert.equal(url.searchParams.get('declineOther'), 'false');
      options.onAccept?.();
      if (options.acceptError) throw Error('Synthetic transport failure');
      current.translations.fr = { ...cell(), text: suggestion().translation, state: 'TRANSLATED', activeSuggestionCount: 0, suggestions: [] };
      if (options.wrongText) current.translations.fr.text = 'Other text';
      return { accepted: { ...suggestion(), state: 'ACCEPTED' }, declined: options.declined ?? [] };
    }
    if (url.pathname === `${stem}/translations/20/set-state/REVIEWED`) {
      assert.equal(method, 'PUT');
      current.translations.fr.state = 'REVIEWED';
      return clone(current.translations.fr);
    }
    throw Error(`Unexpected fixture operation: ${method} ${route}`);
  };
  return { api: handler, calls, current };
}

test('simple Tolgee ICU is converted to validated plain i18next, complex syntax fails closed', () => {
  assert.equal(fromTolgee('Annuler {game} ?'), 'Annuler {{game}} ?');
  assert.equal(fromTolgee("Votre clé d'accès"), "Votre clé d'accès");
  assert.equal(fromTolgee("Votre compte n''est pas connecté"), "Votre compte n'est pas connecté");
  for (const value of ['{n, plural, one {One} other {Many}}', '{game,number}', '{{game}}', "'{game}'", '<b>Text</b>', '$t(secret)', '\u0000', '{game', '', null, 'x'.repeat(12001)]) {
    assert.throws(() => fromTolgee(value));
  }
});

test('eligible French placeholder and Spanish text are accepted by the technical policy', () => {
  assert.equal(assess(row(), languages[1], english).reason, 'eligible');
  const other = row(); other.translations.es = { ...cell(), suggestions: [{ ...suggestion(), translation: '¿Cancelar {game}?' }] };
  assert.equal(assess(other, languages[2], english).reason, 'eligible');
});

test('protect base English and English variants even if their metadata claims otherwise', () => {
  assert.equal(assess(row(), languages[0], english).reason, 'protected-source');
  assert.equal(assess(row(), { tag: 'en-GB', base: false }, english).reason, 'protected-source');
});

test('standard main and legacy branchless keys work, arbitrary branches and namespaces stay protected', () => {
  const value = row();
  assert.equal(assess(value, languages[1], english).reason, 'eligible');
  value.branch = null;
  assert.equal(assess(value, languages[1], english).reason, 'eligible');
  value.branch = 'feature';
  assert.equal(assess(value, languages[1], english).reason, 'unsupported-branch');
  value.branch = 'main'; value.keyNamespace = 'other';
  assert.equal(assess(value, languages[1], english).reason, 'nondefault-namespace');
  value.keyNamespace = null; value.keyName = 'unknown';
  assert.equal(assess(value, languages[1], english).reason, 'unknown-key');
});

test('skip existing, flagged, plural, unknown and competing translations', () => {
  for (const mutate of [
    value => { value.translations.fr.text = 'Déjà traduit'; },
    value => { value.translations.fr.state = 'REVIEWED'; },
    value => { value.translations.fr.outdated = true; },
    value => { value.translations.fr.unresolvedCommentCount = 1; },
    value => { value.translations.fr.qaIssueCount = 1; },
    value => { value.translations.fr.activeSuggestionCount = 2; },
    value => { value.translations.fr.suggestions = []; },
    value => { value.translations.fr.suggestions[0].isPlural = true; },
    value => { value.keyIsPlural = true; },
    value => { value.keyNamespace = 'other'; },
    value => { value.branch = 'feature'; },
    value => { value.keyName = '__proto__'; },
    value => { value.translations.en.text = 'Changed {game}?'; },
    value => { value.keyMaxCharLimit = 2; },
  ]) {
    const value = row(); mutate(value);
    assert.notEqual(assess(value, languages[1], english).reason, 'eligible');
  }
});

test('missing, extra and repeated parameters, markup, hidden controls and wrong scripts are skipped', () => {
  for (const translation of ['Annuler ?', 'Annuler {other} ?', 'Annuler {game} {game} ?', '<b>Annuler {game}</b>',
    'Annuler {{-game}}', ' Annuler {game} ?', 'Annuler {game}\u202e ?', 'Отменить {game}?', 'Cancel {game}?', 'x'.repeat(300) + '{game}']) {
    const value = row(); value.translations.fr.suggestions[0].translation = translation;
    assert.notEqual(assess(value, languages[1], english).reason, 'eligible');
  }
  const value = row(); value.translations.fr.suggestions[0].translation = 'Annuler {game} ?';
  const japanese = { id: 5, tag: 'ja', base: false };
  value.translations.ja = value.translations.fr;
  assert.equal(assess(value, japanese, english).reason, 'language-needs-review');
  value.translations.ja.suggestions[0].translation = '{game}をキャンセルしますか？';
  assert.equal(assess(value, japanese, english).reason, 'eligible');
});

test('preserve URLs, named products and CLI/backtick identifiers exactly', () => {
  const source = { help: 'Open Xbox at https://example.com/help with `file.json` and --safe.' };
  const value = row(); value.keyName = 'help'; value.translations.en.text = source.help;
  value.translations.fr.suggestions[0].translation = 'Ouvrez Xbox sur https://example.com/help avec `file.json` et --safe.';
  assert.equal(assess(value, languages[1], source).reason, 'eligible');
  for (const [old, replacement] of [['Xbox', 'Xboks'], ['example.com', 'evil.example'], ['file.json', 'other.json'], ['--safe', '--unsafe']]) {
    const altered = clone(value); altered.translations.fr.suggestions[0].translation = altered.translations.fr.suggestions[0].translation.replace(old, replacement);
    assert.equal(assess(altered, languages[1], source).reason, 'changed-protected-token');
  }
});

test('preview is read-only and report excludes texts, contributor data and identifiers', async () => {
  const { api, calls } = fixture();
  const report = await acceptSuggestions({ api, english });
  assert.equal(report.accepted, 0); assert.equal(report.linguisticReview, false);
  assert.deepEqual(report.entries, [{ key: 'common.cancel_game', language: 'fr', status: 'eligible' }]);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.doesNotMatch(JSON.stringify(report), /Annuler|languageId|keyId|author|translation:/);
});

test('accept rechecks state and single active view candidate using minimal scopes, retaining authorship', async () => {
  const { api, calls, current } = fixture();
  const report = await acceptSuggestions({ api, english, apply: true, reviewed: true, tags: ['fr'] });
  assert.equal(report.accepted, 1); assert.equal(report.reviewed, 1);
  assert.equal(current.translations.fr.state, 'REVIEWED');
  assert.equal(current.translations.en.text, 'Cancel {game}?');
  assert.equal(report.entries[0].status, 'accepted-and-reviewed');
  assert.equal(calls.filter(call => call.method === 'PUT').length, 2);
  assert.ok(calls.every(call => call.method !== 'GET' || !call.route.includes('/suggestion')));
  assert.ok(calls.every(call => !/decline\?|delete|single-step-import/.test(call.route)));
});

test('accept without reviewed flag leaves accepted translations for language review', async () => {
  const { api, calls } = fixture();
  const report = await acceptSuggestions({ api, english, apply: true });
  assert.equal(report.accepted, 1); assert.equal(report.reviewed, 0);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});

test('opt-in review snapshot exports only public UI pairs and binds approval to their digest', async () => {
  const preview = fixture();
  const report = await acceptSuggestions({ api: preview.api, english, texts: true });
  assert.deepEqual(report.reviewSnapshot, [{ language: 'fr', key: 'common.cancel_game', source: 'Cancel {{game}}?', translation: 'Annuler {{game}} ?' }]);
  assert.match(report.reviewDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(report.reviewSnapshot), /author|languageId|keyId|suggestionId/);
  assert.deepEqual(report.suggestionSnapshot, [{ language: 'fr', key: 'common.cancel_game', source: 'Cancel {game}?',
    current: null, state: 'UNTRANSLATED', reason: 'eligible', suggestions: [{ text: 'Annuler {game} ?', plural: false }] }]);
  assert.doesNotMatch(JSON.stringify(report.suggestionSnapshot), /author|languageId|keyId|suggestionId/);
  const actual = fixture();
  assert.equal((await acceptSuggestions({ api: actual.api, english, apply: true, reviewed: true, reviewDigest: report.reviewDigest })).reviewed, 1);
  const changed = fixture({ beforeView: value => { value.translations.fr.suggestions[0].translation = 'Ignorer {game} ?'; } });
  await assert.rejects(acceptSuggestions({ api: changed.api, english, apply: true, reviewDigest: report.reviewDigest }), /changed since/);
  assert.ok(changed.calls.every(call => call.method === 'GET'));
});

test('explicit text audit includes blocked candidates without accepting them or exporting identities', async () => {
  const preview = fixture({ beforeView: value => { value.translations.fr.suggestions[0].translation = 'Annuler ?'; } });
  const report = await acceptSuggestions({ api: preview.api, english, texts: true });
  assert.deepEqual(report.reviewSnapshot, []);
  assert.equal(report.suggestionSnapshot[0].reason, 'invalid-text-or-parameters');
  assert.equal(report.suggestionSnapshot[0].suggestions[0].text, 'Annuler ?');
  assert.ok(preview.calls.every(call => call.method === 'GET'));
  assert.doesNotMatch(JSON.stringify(report.suggestionSnapshot), /author|languageId|keyId|suggestionId/);
});

test('language-review exclusions are validated and never accepted or reviewed', async () => {
  const { api, calls } = fixture();
  const report = await acceptSuggestions({ api, english, apply: true, reviewed: true, exclude: ['fr:common.cancel_game'] });
  assert.equal(report.accepted, 0); assert.equal(report.reviewed, 0);
  assert.equal(report.entries[0].status, 'excluded-by-language-review');
  assert.ok(calls.every(call => call.method === 'GET'));
  for (const exclude of [['en:common.cancel_game'], ['fr:unknown'], ['fr:common.cancel_game:other']]) {
    await assert.rejects(acceptSuggestions({ api: fixture().api, english, apply: true, exclude }));
  }
  await assert.rejects(acceptSuggestions({ api: fixture().api, english, apply: true, texts: true }));
});

test('changed cells or changed source before accept are skipped without any mutation', async () => {
  for (const change of [
    value => { value.translations.fr.text = 'Another reviewer'; },
    value => { value.translations.en.text = 'New source {game}'; },
    value => { value.translations.fr.suggestions[0].translation = 'Autre texte {game}'; },
    value => { value.branch = null; },
    value => { value.branch = 'feature'; },
  ]) {
    const { api, calls } = fixture({ beforeView: (value, reads) => { if (reads === 2) change(value); } });
    const report = await acceptSuggestions({ api, english, apply: true });
    assert.equal(report.entries[0].status, 'changed-before-accept');
    assert.ok(calls.every(call => call.method === 'GET'));
  }
});

test('fresh view must still prove exactly one identical ACTIVE nonplural candidate', async () => {
  for (const change of [
    value => { value.translations.fr.activeSuggestionCount = 2; },
    value => { value.translations.fr.suggestions = []; },
    value => { value.translations.fr.suggestions[0].state = 'DECLINED'; },
    value => { value.translations.fr.suggestions[0].id = 41; },
    value => { value.translations.fr.suggestions[0].isPlural = true; },
  ]) {
    const { api, calls } = fixture({ beforeView: (value, reads) => { if (reads === 2) change(value); } });
    const report = await acceptSuggestions({ api, english, apply: true });
    assert.equal(report.entries[0].status, 'changed-before-accept');
    assert.ok(calls.every(call => call.method === 'GET'));
  }
});

test('uncertain write is not retried, partial report retained and no review attempted', async () => {
  const { api, calls } = fixture({ acceptError: true }); const report = {};
  await assert.rejects(acceptSuggestions({ api, english, apply: true, reviewed: true, report }));
  assert.equal(report.entries[0].status, 'accept-outcome-unknown');
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});

test('changed post-accept value or unexpected declined suggestions abort the batch', async () => {
  for (const options of [{ wrongText: true }, { declined: [42] }]) {
    const { api, calls } = fixture(options);
    await assert.rejects(acceptSuggestions({ api, english, apply: true, reviewed: true }));
    assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  }
});

test('base mismatch, duplicate language IDs/tags and invalid target tags fail before writes', async () => {
  for (const options of [
    { languages: languages.map(value => ({ ...value, base: value.tag === 'fr' })) },
    { languages: [...languages, languages[1]] },
  ]) {
    const { api, calls } = fixture(options);
    await assert.rejects(acceptSuggestions({ api, english, apply: true }));
    assert.ok(calls.every(call => call.method === 'GET'));
  }
  for (const tag of ['en', 'en-US', 'pt-br', 'xx', 'fr\n--apply']) {
    const { api } = fixture();
    await assert.rejects(acceptSuggestions({ api, english, apply: true, tags: [tag] }));
  }
});

test('pagination is bounded, consistent and read completely before any writes', async () => {
  const normal = fixture(); let scanned = false;
  const api = async (route, method) => {
    const url = new URL(`https://app.tolgee.io${route}`);
    if (url.pathname.endsWith('/translations') && !url.searchParams.has('filterKeyId')) {
      const number = Number(url.searchParams.get('page'));
      if (number === 1) scanned = true;
      return page('keys', number === 0 ? [row()] : [{ ...row(), keyId: 11, translations: {} }], number, 2);
    }
    if (method === 'PUT') assert.equal(scanned, true);
    return normal.api(route, method);
  };
  assert.equal((await acceptSuggestions({ api, english, apply: true })).accepted, 1);
  await assert.rejects(acceptSuggestions({ english, api: async () => ({ _embedded: { languages }, page: { number: 0, totalPages: 101 } }) }));
  const bad = async route => route.includes('/languages?') ? page('languages', languages) : page('keys', [row(), row()]);
  await assert.rejects(acceptSuggestions({ english, api: bad }));
});

test('API client fixes origin, rejects redirects and limits/parses response data without leaking secrets', async () => {
  for (const key of ['', undefined, 'bad\nkey']) assert.throws(() => createApi(key));
  const calls = [];
  const api = createApi('synthetic-only', async (url, options) => {
    calls.push({ url, options }); return new Response('{"ok":true}');
  });
  assert.deepEqual(await api('/v2/projects/36162/languages'), { ok: true });
  assert.equal(calls[0].url, 'https://app.tolgee.io/v2/projects/36162/languages');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  for (const route of ['https://evil.example', '//evil.example', '/v2/projects/1/languages', '/v2/projects/36162/../other', '/v2/projects/36162/languages#fragment']) await assert.rejects(api(route));
  for (const fetcher of [async () => new Response('secret-payload', { status: 403 }), async () => new Response('secret-payload'),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), async () => { throw Error('secret-token'); }]) {
    await assert.rejects(createApi('synthetic-only', fetcher)('/v2/projects/36162/languages'), error => !/secret/.test(error.message));
  }
});

test('real HTTP fixture executes preview then acceptance and review, no live account needed', async () => {
  const backing = fixture(); const seenMethods = [];
  const server = http.createServer(async (request, response) => {
    seenMethods.push(request.method);
    assert.equal(request.headers['x-api-key'], 'synthetic-fixture');
    try {
      const value = await backing.api(request.url, request.method);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    } catch { response.writeHead(500); response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = createApi('synthetic-fixture', (url, options) => {
      const incoming = new URL(url);
      assert.equal(incoming.origin, 'https://app.tolgee.io');
      return fetch(`http://127.0.0.1:${server.address().port}${incoming.pathname}${incoming.search}`, options);
    });
    assert.equal((await acceptSuggestions({ api, english })).entries[0].status, 'eligible');
    assert.ok(seenMethods.every(value => value === 'GET'));
    assert.equal((await acceptSuggestions({ api, english, apply: true, reviewed: true })).reviewed, 1);
    assert.equal(seenMethods.filter(value => value === 'PUT').length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('GET 429 honors bounded Retry-After, PUT and uncertain requests are never retried', async () => {
  const waits = []; let calls = 0;
  const api = createApi('synthetic-only', async () => {
    calls++;
    return calls < 3 ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) : new Response('{"ok":true}');
  }, async milliseconds => { waits.push(milliseconds); });
  assert.deepEqual(await api('/v2/projects/36162/languages'), { ok: true });
  assert.deepEqual(waits, [2000, 2000]); assert.equal(calls, 3);
  for (const method of ['GET', 'PUT']) {
    let attempts = 0;
    const limited = createApi('synthetic-only', async () => { attempts++; return new Response('{}', { status: 429 }); }, async () => {});
    await assert.rejects(limited('/v2/projects/36162/languages', method), /HTTP 429/);
    assert.equal(attempts, method === 'GET' ? 3 : 1);
  }
  for (const header of ['99999', 'invalid']) {
    const limited = createApi('synthetic-only', async () => new Response('{}', { status: 429, headers: { 'retry-after': header } }), async () => { throw Error('Must not wait'); });
    await assert.rejects(limited('/v2/projects/36162/languages'), /later attempt/);
  }
});

test('multi-key batches verify every entry with at most two views per twenty candidates', async () => {
  const source = {}; const values = new Map(); const calls = []; let views = 0;
  for (let i = 0; i < 45; i++) {
    source[`item${i}`] = 'Cancel {{game}}?';
    const value = row(); value.keyId = 100 + i; value.keyName = `item${i}`;
    value.translations.fr.suggestions = [{ ...suggestion(), id: 500 + i, keyId: value.keyId }];
    values.set(value.keyId, value);
  }
  const api = async (route, method = 'GET') => {
    calls.push({ route, method }); const url = new URL(`https://app.tolgee.io${route}`);
    if (url.pathname.endsWith('/languages')) return page('languages', languages);
    if (url.pathname.endsWith('/translations')) {
      views++;
      const selected = url.searchParams.getAll('filterKeyId').map(Number);
      if (selected.length) assert.ok(selected.length <= 20);
      if (views === 2) values.get(102).translations.fr.text = 'Manual edit before batch';
      return page('keys', clone([...values.values()].filter(value => !selected.length || selected.includes(value.keyId))));
    }
    const accept = url.pathname.match(/languages\/2\/key\/(\d+)\/suggestion\/(\d+)\/accept$/);
    if (accept) {
      const value = values.get(Number(accept[1])); const candidate = value.translations.fr.suggestions[0];
      assert.equal(candidate.id, Number(accept[2]));
      value.translations.fr.text = candidate.translation; value.translations.fr.id = value.keyId + 1000;
      value.translations.fr.state = 'TRANSLATED';
      return { accepted: { ...candidate, state: 'ACCEPTED' }, declined: [] };
    }
    const review = url.pathname.match(/translations\/(\d+)\/set-state\/REVIEWED$/);
    if (review) {
      const value = values.get(Number(review[1]) - 1000);
      value.translations.fr.state = 'REVIEWED'; return clone(value.translations.fr);
    }
    throw Error('Unexpected operation');
  };
  const report = await acceptSuggestions({ api, english: source, apply: true, reviewed: true });
  assert.equal(views, 7); // initial snapshot + two views for each of three groups
  assert.equal(report.accepted, 44); assert.equal(report.reviewed, 44);
  assert.equal(report.entries.find(value => value.key === 'item2').status, 'changed-before-accept');
  assert.equal(values.get(102).translations.fr.text, 'Manual edit before batch');
  assert.equal(calls.filter(value => value.method === 'PUT').length, 88);
});

test('production-style request spacing is conservative and does not change response semantics', async () => {
  const waits = [];
  const api = createApi('synthetic', async () => new Response('{}'), async value => { waits.push(value); }, 200);
  await api('/v2/projects/36162/languages');
  await api('/v2/projects/36162/languages');
  assert.equal(waits.length, 1); assert.ok(waits[0] > 100 && waits[0] <= 200);
});

test('CLI is default preview, unknown/duplicate/injected flags fail closed', () => {
  assert.deepEqual(argumentsFor([]), { apply: false, reviewed: false, tags: [] });
  assert.deepEqual(argumentsFor(['--apply', '--reviewed', '--languages', 'fr,es']), { apply: true, reviewed: true, tags: ['fr', 'es'] });
  for (const args of [['--reviewed'], ['--apply', '--apply'], ['--languages'], ['--languages', 'fr,fr'], ['--languages', 'fr;echo bad'], ['--host', 'https://evil.example']]) assert.throws(() => argumentsFor(args));
  assert.equal(argumentsFor(['--texts']).texts, true);
  assert.deepEqual(argumentsFor(['--exclude', 'fr:auth.browser']).exclude, ['fr:auth.browser']);
  for (const args of [['--texts', '--apply'], ['--exclude', 'bad'], ['--review-digest', 'bad']]) assert.throws(() => argumentsFor(args));
});

test('workflow is main-only manual, serializes source sync, isolates review secret and never releases or pushes', async () => {
  const yaml = createRequire(import.meta.url)('js-yaml');
  const workflow = yaml.load(await fs.readFile('.github/workflows/translation-suggestions.yml', 'utf8'));
  const source = yaml.load(await fs.readFile('.github/workflows/translations.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, 'preview');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, source.concurrency);
  assert.equal(workflow.jobs.suggestions.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(workflow.jobs.suggestions.steps[0].with, { ref: 'main', 'persist-credentials': false });
  const secretSteps = workflow.jobs.suggestions.steps.filter(step => JSON.stringify(step).includes('secrets.'));
  assert.equal(secretSteps.length, 1);
  assert.equal(secretSteps[0].env.TOLGEE_REVIEW_API_KEY, '${{ secrets.TOLGEE_REVIEW_API_KEY }}');
  assert.doesNotMatch(secretSteps[0].run, /\$\{\{/);
  assert.doesNotMatch(JSON.stringify(workflow), /TOLGEE_SOURCE_API_KEY|npm run build|gh release|git push|pull_request|schedule/);
});
