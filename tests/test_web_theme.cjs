// Run with: node tests/test_web_theme.cjs (no browser or packages required).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../web/theme.js`, 'utf8');
function load(saved, dark, blocked = false) {
  const root = {dataset: {}};
  const meta = {};
  const media = {matches: dark, addEventListener(_, callback) { this.changed = callback; }};
  const context = vm.createContext({
    document: {documentElement: root, querySelector: () => meta},
    localStorage: {getItem() { if (blocked) throw Error('Storage blocked'); return saved; }},
    matchMedia: () => media,
  });
  vm.runInContext(source, context);
  return {root, meta, media};
}
for (const theme of ['graphite', 'paper', 'midnight']) {
  const {root, media} = load(theme, false);
  assert.equal(root.dataset.theme, theme);
  media.matches = true;
  media.changed();
  assert.equal(root.dataset.theme, theme, 'Explicit themes ignore OS changes');
}
for (const saved of [null, 'invalid', 'system']) {
  const {root, media, meta} = load(saved, false);
  assert.equal(root.dataset.theme, 'paper');
  media.matches = true;
  media.changed();
  assert.equal(root.dataset.theme, 'graphite');
  assert.equal(meta.content, '#141716');
}
assert.equal(load(null, true, true).root.dataset.theme, 'graphite');
console.log('Theme defaults, saved preferences, system changes and blocked storage passed.');
