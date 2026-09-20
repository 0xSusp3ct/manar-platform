import assert from 'node:assert/strict';
import { emailReady, sendAccessCode, sendReportLink } from '../vercel/email.js';

const originalFetch = globalThis.fetch;
const config = { RESEND_API_KEY: 're_test_only', RESEND_FROM: 'Manar <reports@example.test>' };
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return new Response(JSON.stringify({ id: 'test-message-id' }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  assert.equal(emailReady({}), false);
  assert.equal(emailReady(config), true);
  assert.deepEqual(await sendAccessCode({}, { to: 'example@test.invalid' }), { sent: false, reason: 'not_configured' });
  assert.equal(calls.length, 0);

  const access = await sendAccessCode(config, {
    to: 'recipient@example.test',
    entityName: '<script>اختبار</script>',
    code: 'MNR-TEST-CODE-1234',
    expiresAt: '2026-09-30T00:00:00.000Z',
    baseUrl: 'https://manar.example.test',
  });
  assert.deepEqual(access, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer re_test_only');
  const accessBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(accessBody.to, ['recipient@example.test']);
  assert.match(accessBody.html, /&lt;script&gt;اختبار&lt;\/script&gt;/);
  assert.doesNotMatch(accessBody.html, /<script>/);
  assert.match(accessBody.html, /MNR-TEST-CODE-1234/);

  const report = await sendReportLink(config, {
    to: 'recipient@example.test', entityName: 'جهة اختبار', reportUrl: 'https://manar.example.test/r/test-token',
  });
  assert.deepEqual(report, { sent: true });
  assert.match(JSON.parse(calls[1].init.body).html, /https:\/\/manar.example.test\/r\/test-token/);

  globalThis.fetch = async () => new Response(JSON.stringify({ name: 'validation_error', message: 'invalid sender' }), { status: 422, headers: { 'content-type': 'application/json' } });
  const failed = await sendReportLink(config, { to: 'recipient@example.test', entityName: 'جهة', reportUrl: 'https://manar.example.test/r/test-token' });
  assert.deepEqual(failed, { sent: false, reason: 'delivery_failed' });
  console.log('Email adapter tests passed: missing config, access code, report link, escaped content, and delivery failure.');
} finally {
  globalThis.fetch = originalFetch;
}
