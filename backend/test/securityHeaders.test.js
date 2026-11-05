// backend/test/securityHeaders.test.js — the headers every response carries.
//
// Asserted on a real HTTP response rather than on the config object, because
// what matters is what reaches the browser: a directive helmet silently drops
// or renames would pass a config check and still leave the hall frameable.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { securityHeaders } = require('../securityHeaders');

function serve(production) {
  const app = express();
  app.use(securityHeaders({ production }));
  app.get('/', (req, res) => res.send('ok'));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const directive = (csp, name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);

for (const production of [true, false]) {
  describe(production ? 'in production' : 'in local dev', () => {
    let server;
    let headers;
    before(async () => {
      server = await serve(production);
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
      headers = res.headers;
    });
    after(() => server.close());

    test('no other site can frame the hall', () => {
      assert.equal(directive(headers.get('content-security-policy'), 'frame-ancestors'), "frame-ancestors 'none'");
      assert.equal(headers.get('x-frame-options'), 'DENY');
    });

    test('scripts only from this site — nothing inline, nothing third-party', () => {
      assert.equal(directive(headers.get('content-security-policy'), 'script-src'), "script-src 'self'");
      assert.equal(directive(headers.get('content-security-policy'), 'object-src'), "object-src 'none'");
    });

    test('the browser talks only to this site', () => {
      assert.equal(directive(headers.get('content-security-policy'), 'connect-src'), "connect-src 'self'");
    });

    test('Google Fonts and HTTPS images still load', () => {
      const csp = headers.get('content-security-policy');
      assert.match(directive(csp, 'style-src'), /https:\/\/fonts\.googleapis\.com/);
      assert.match(directive(csp, 'font-src'), /https:\/\/fonts\.gstatic\.com/);
      assert.match(directive(csp, 'img-src'), / https:( |$)/);
      assert.match(directive(csp, 'img-src'), / blob:/, 'build-scan previews are blob: URLs');
    });

    test('does not announce Express', () => {
      assert.equal(headers.get('x-powered-by'), null);
    });

    test(production ? 'pins HTTPS' : 'leaves HTTP alone, so localhost works', () => {
      const csp = headers.get('content-security-policy');
      if (production) {
        assert.ok(headers.get('strict-transport-security'), 'HSTS sent');
        assert.ok(directive(csp, 'upgrade-insecure-requests'), 'upgrade-insecure-requests sent');
      } else {
        assert.equal(headers.get('strict-transport-security'), null);
        assert.equal(directive(csp, 'upgrade-insecure-requests'), undefined);
      }
    });
  });
}
