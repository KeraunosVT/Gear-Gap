// backend/test/locales.test.js — the site's translations stay in step.
//
// English (frontend/src/locales/en.js) is the source. A key only in es/pt is a
// typo that never shows; a key missing from es/pt silently falls back to
// English mid-page; a translation that drops a {placeholder} shows the wrong
// number or name, and one that drops a <tag> loses its link. Each of those
// fails here rather than on someone's screen.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LOCALES = path.join(__dirname, '..', '..', 'frontend', 'src', 'locales');
const load = async (lang) => (await import(pathToFileURL(path.join(LOCALES, `${lang}.js`)).href)).default;

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...String(s).matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();

let en;
before(async () => { en = await load('en'); });

for (const lang of ['es', 'pt']) {
  describe(`${lang} translations`, () => {
    let dict;
    before(async () => { dict = await load(lang); });

    test('has every English key and nothing else', () => {
      const missing = Object.keys(en).filter((k) => !(k in dict));
      const extra = Object.keys(dict).filter((k) => !(k in en));
      assert.deepEqual(missing, [], `missing from ${lang}`);
      assert.deepEqual(extra, [], `in ${lang} but not English`);
    });

    test('keeps every {placeholder} and <tag>', () => {
      for (const [k, v] of Object.entries(en)) {
        if (!(k in dict)) continue;
        // A plural form may drop {count} ("one day" vs "{count} days"), so
        // only a placeholder the translation adds is wrong there.
        if (/_(one|other)$/.test(k)) {
          const extra = placeholders(dict[k]).filter((p) => !placeholders(v).includes(p) && p !== 'count');
          assert.deepEqual(extra, [], `${lang} ${k} adds a placeholder`);
        } else {
          assert.deepEqual(placeholders(dict[k]), placeholders(v), `${lang} ${k} placeholders`);
        }
        assert.deepEqual(tags(dict[k]), tags(v), `${lang} ${k} tags`);
      }
    });

    test('no empty strings', () => {
      const empty = Object.entries(dict).filter(([, v]) => !String(v).trim()).map(([k]) => k);
      assert.deepEqual(empty, []);
    });
  });
}
