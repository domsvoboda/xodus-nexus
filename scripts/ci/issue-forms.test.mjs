import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const yaml = createRequire(import.meta.url)('js-yaml');
const directory = '.github/ISSUE_TEMPLATE';
const names = ['01-launcher-bug', '02-game-bug', '03-startup-or-no-logs', '04-feature-request'];
const read = async name => yaml.load(await fs.readFile(`${directory}/${name}.yml`, 'utf8'));
const fields = form => new Map(form.body.filter(field => field.type !== 'markdown').map(field => [field.id, field]));
const required = (form, id, type) => {
  const field = fields(form).get(id);
  assert.ok(field, `Missing ${id}`);
  if (type) assert.equal(field.type, type, id);
  assert.equal(field.validations?.required, true, `${id} must be required`);
  return field;
};

test('issue chooser disables blank issues and keeps every supported report route', async () => {
  const config = await read('config');
  assert.equal(config.blank_issues_enabled, false);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['config.yml', ...names.map(name => `${name}.yml`)].sort());
  for (const link of config.contact_links) {
    assert.ok(link.name && link.about);
    assert.equal(new URL(link.url).origin, 'https://github.com');
    assert.ok(new URL(link.url).pathname.startsWith('/domsvoboda/nexus-launcher/'));
  }
});

test('issue forms use supported field schemas and unambiguous, non-prefilled required controls', async () => {
  const allowed = {
    markdown: ['value'], input: ['label', 'description', 'placeholder', 'value'],
    textarea: ['label', 'description', 'placeholder', 'value', 'render'],
    dropdown: ['label', 'description', 'multiple', 'options', 'default'],
    checkboxes: ['label', 'description', 'options'], upload: ['label', 'description'],
  };
  const formNames = new Set();
  for (const name of names) {
    const form = await read(name);
    assert.ok(form.name.length > 3 && form.description && form.title);
    assert.ok(!formNames.has(form.name)); formNames.add(form.name);
    assert.ok(form.body.length > 0);
    const ids = new Set(), labels = new Set();
    for (const field of form.body) {
      assert.ok(Object.hasOwn(allowed, field.type), `${name}: ${field.type}`);
      assert.ok(field.attributes && typeof field.attributes === 'object');
      for (const key of Object.keys(field.attributes)) assert.ok(allowed[field.type].includes(key), `${name}: unsupported ${key}`);
      if (field.type === 'markdown') { assert.equal(typeof field.attributes.value, 'string'); continue; }
      assert.match(field.id, /^[A-Za-z0-9_-]+$/);
      assert.ok(!ids.has(field.id)); ids.add(field.id);
      assert.equal(typeof field.attributes.label, 'string');
      assert.ok(!labels.has(field.attributes.label)); labels.add(field.attributes.label);
      // Checkbox requirements are on each option, not on the group.
      if (field.type !== 'checkboxes') assert.equal(typeof field.validations?.required, 'boolean');
      // Placeholders are guidance, not already-filled answers that bypass required fields.
      assert.equal(field.attributes.value, undefined);
      if (field.type === 'dropdown') {
        assert.ok(field.attributes.options.length >= 2);
        assert.equal(new Set(field.attributes.options).size, field.attributes.options.length);
        assert.ok(field.attributes.options.every(option => typeof option === 'string'));
        assert.equal(field.attributes.default, undefined);
      }
      if (field.type === 'upload') {
        assert.ok(field.validations.accept.split(',').every(ext => ['.log', '.txt', '.zip', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)));
      }
      if (field.validations?.min_length !== undefined) {
        assert.ok(['textarea', 'input'].includes(field.type));
        assert.ok(Number.isInteger(field.validations.min_length) && field.validations.min_length > 0);
      }
      if (field.type === 'checkboxes') assert.ok(field.attributes.options.every(option => option.label && option.required === true));
    }
    const text = JSON.stringify(form);
    assert.ok(text.includes('independent, unofficial project'));
    assert.doesNotMatch(text, /\u2014/);
  }
});

test('every bug route requires separate component versions, system details and reproduction', async () => {
  for (const name of names.slice(0, 3)) {
    const form = await read(name);
    for (const id of ['launcher-version', 'backend-version', 'runtime-version', 'distro']) required(form, id, 'input');
    for (const id of ['hardware', 'problem', 'reproduction']) required(form, id, 'textarea');
    for (const id of ['session', 'installation']) required(form, id, 'dropdown');
    const hardware = required(form, 'hardware');
    for (const part of ['CPU', 'GPU', 'RAM']) assert.ok(hardware.attributes.description.includes(part));
    assert.ok(fields(form).get('session').attributes.options.includes('Steam Gaming Mode'));
    assert.ok(fields(form).get('session').attributes.options.includes('Desktop (Wayland)'));
    assert.ok(fields(form).get('session').attributes.options.includes('Desktop (X11)'));
  }
});

test('normal bug routes require actual log attachments, not just screenshots', async () => {
  for (const name of names.slice(0, 2)) {
    const form = await read(name);
    const log = required(form, 'logs', 'upload');
    assert.equal(log.validations.accept, '.log,.txt,.zip');
    assert.ok(log.attributes.description.includes('failing attempt'));
    assert.equal(fields(form).get('screenshots').validations.required, false);
    const text = JSON.stringify(form);
    assert.ok(text.includes('Open backend diagnostic log'));
    assert.ok(text.includes('Copy log'));
  }
  const launcher = JSON.stringify(await read('01-launcher-bug'));
  assert.ok(launcher.includes('Cannot start Nexus / logs unavailable'));
  for (const word of ['tokens', 'cookies', 'signed URLs', 'saves']) assert.ok(launcher.includes(word));
  const game = await read('02-game-bug');
  required(game, 'game', 'input'); required(game, 'access', 'dropdown');
  assert.ok(JSON.stringify(game).includes('Verbose game logs'));
  assert.ok(JSON.stringify(game).includes('turn verbose logging off'));
  assert.ok(JSON.stringify(await read('01-launcher-bug')).includes('Install Queue → Show log'));
});

test('no-log exception requires an explanation and terminal evidence, but never a nonexistent file', async () => {
  const form = await read('03-startup-or-no-logs');
  assert.ok(required(form, 'missing-log-reason', 'textarea').validations.min_length >= 40);
  assert.ok(required(form, 'terminal-output', 'textarea').attributes.description.includes('no output'));
  assert.equal(fields(form).get('available-files').validations.required, false);
  assert.ok(form.body.filter(field => field.type === 'upload').every(field => field.validations.required === false));
  assert.ok(JSON.stringify(form).includes('Do not run it as root'));
});

test('feature requests do not demand bug logs, versions or hardware', async () => {
  const form = await read('04-feature-request');
  required(form, 'problem', 'textarea'); required(form, 'proposal', 'textarea');
  for (const id of ['logs', 'hardware', 'launcher-version', 'backend-version', 'runtime-version', 'distro']) assert.ok(!fields(form).has(id));
  assert.ok(!form.body.some(field => field.type === 'upload'));
});
