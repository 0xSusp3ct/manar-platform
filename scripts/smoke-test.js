import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

const databasePath = path.join(os.tmpdir(), `manar-smoke-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = databasePath;
process.env.COOKIE_SECURE = 'false';
process.env.TOKEN_SECRET = 'smoke-test-token-secret-1234567890-abcdef';
process.env.ADMIN_EMAIL = 'owner@example.test';
process.env.ADMIN_PASSWORD = 'StrongSmokePassword-2026';
process.env.SCORING_PROFILE = 'current50';

const app = await createApp({ databasePath });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.BASE_URL = base;

const adminCookies = {};
const assessmentCookies = {};
const supervisorCookies = {};

try {
  const health = await request('/api/health');
  assert.equal(health.data.ok, true);

  const requested = await request('/api/requests', { method: 'POST', body: { entityName: 'جمعية الاختبار', assessorName: 'فريق الجودة', email: 'quality@example.test', phone: '', notes: 'اختبار آلي' } });
  assert.equal(requested.response.status, 201);

  const login = await request('/api/admin/login', { method: 'POST', body: { email: 'owner@example.test', password: 'StrongSmokePassword-2026' }, jar: adminCookies });
  assert.equal(login.response.status, 200);

  const overview = await request('/api/admin/overview', { jar: adminCookies });
  assert.equal(overview.data.requests.length, 1);

  const approved = await request(`/api/admin/requests/${requested.data.requestId}/approve`, { method: 'POST', body: { sendEmail: false }, jar: adminCookies });
  assert.match(approved.data.accessCode, /^MNR-/);

  const entered = await request('/api/access', { method: 'POST', body: { code: approved.data.accessCode }, jar: assessmentCookies });
  assert.equal(entered.response.status, 200);

  const assessment = await request('/api/assessment', { jar: assessmentCookies });
  const indicators = assessment.data.structure.flatMap((domain) => domain.axes.flatMap((axis) => axis.indicators));
  assert.equal(indicators.length, 50);
  const answers = Object.fromEntries(indicators.map((item, index) => [item.id, (index % 5) + 1]));
  const entity = { entityName: 'جمعية الاختبار', assessorName: 'فريق الجودة', evaluationDate: '2026-09-13' };
  await request('/api/assessment/draft', { method: 'PUT', body: { entity, answers }, jar: assessmentCookies });
  const submitted = await request('/api/assessment/submit', { method: 'POST', body: { entity, answers }, jar: assessmentCookies });
  assert.equal(submitted.response.status, 201);

  const reportToken = new URL(submitted.data.reportUrl).pathname.split('/').pop();
  const report = await request(`/api/reports/${reportToken}`);
  assert.equal(report.data.entity.entityName, entity.entityName);
  assert.equal(report.data.result.indicatorCount, 50);

  await request(`/api/admin/results/${submitted.data.resultId}/advisory`, { method: 'PATCH', body: { recommendations: 'توصية اختبارية', improvementPlan: 'خطة اختبارية' }, jar: adminCookies });
  const link = await request(`/api/admin/results/${submitted.data.resultId}/share-link`, { method: 'POST', body: { sendEmail: false }, jar: adminCookies });
  assert.match(link.data.reportUrl, /\/r\//);

  const excel = await request(`/api/admin/results/${submitted.data.resultId}/export.xlsx`, { jar: adminCookies, binary: true });
  assert.equal(excel.response.status, 200);
  assert.equal(excel.buffer.subarray(0, 2).toString(), 'PK');
  await request('/api/admin/users', { method: 'POST', body: { email: 'supervisor@example.test', password: 'StrongSupervisor-2026', role: 'supervisor' }, jar: adminCookies });
  await request('/api/admin/login', { method: 'POST', body: { email: 'supervisor@example.test', password: 'StrongSupervisor-2026' }, jar: supervisorCookies });
  const supervisorOverview = await request('/api/admin/overview', { jar: supervisorCookies });
  assert.equal(supervisorOverview.data.requests.length, 0);
  assert.equal(supervisorOverview.data.results.length, 1);
  const forbidden = await rawRequest('/api/admin/codes', { method: 'POST', body: { label: 'غير مسموح' }, jar: supervisorCookies });
  assert.equal(forbidden.response.status, 403);
  console.log('Smoke test passed: full journey, immutable result, report link, advisory, Excel export, and role separation.');
} finally {
  await new Promise((resolve) => server.close(resolve));
  app.locals.db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${databasePath}${suffix}`); } catch {}
  }
}

async function request(pathname, { method = 'GET', body, jar, binary = false } = {}) {
  const result = await rawRequest(pathname, { method, body, jar, binary });
  if (!result.response.ok) throw new Error(`${method} ${pathname}: ${result.response.status} ${JSON.stringify(result.data || {})}`);
  return result;
}

async function rawRequest(pathname, { method = 'GET', body, jar, binary = false } = {}) {
  const headers = { Origin: base };
  if (body) headers['Content-Type'] = 'application/json';
  if (jar && Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; ');
  const response = await fetch(`${base}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (jar) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const index = pair.indexOf('=');
      if (index > 0) jar[pair.slice(0, index)] = pair.slice(index + 1);
    }
  }
  if (binary) return { response, buffer: Buffer.from(await response.arrayBuffer()) };
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
