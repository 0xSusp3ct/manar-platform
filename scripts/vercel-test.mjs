import assert from "node:assert/strict";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.TOKEN_SECRET = "test-token-secret-1234567890-abcdef";
process.env.ADMIN_EMAIL = "owner@manar.test";
process.env.ADMIN_PASSWORD = "Owner-Test-Password-2026!";
process.env.SCORING_PROFILE = "current50";
process.env.NODE_ENV = "test";

const originalFetch = globalThis.fetch;
const emailCalls = [];

let closeDatabaseForTests;
let getDatabaseForTests;
try {
  const module = await import("../api/index.js");
  const handler = module.default;
  closeDatabaseForTests = module.closeDatabaseForTests;
  getDatabaseForTests = module.getDatabaseForTests;
  let adminCookie = "";
  let assessmentCookie = "";

  async function call(path, { method = "GET", body, rawBody, cookie, ip = "127.0.0.1", headers = {} } = {}) {
    const hasBody = body !== undefined || rawBody !== undefined;
    const response = await handler.fetch(new Request(`https://manar.test${path}`, {
      method,
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        origin: "https://manar.test",
        "x-forwarded-for": ip,
        ...headers,
      },
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    }));
    const type = response.headers.get("content-type") || "";
    const data = type.includes("json") ? await response.json() : new Uint8Array(await response.arrayBuffer());
    return { response, data };
  }

  let out = await call("/api/health");
  assert.equal(out.response.status, 200);
  assert.equal(out.data.ok, true);
  const testDatabase = getDatabaseForTests();

  out = await call("/api/requests", { method: "POST", rawBody: "{bad", ip: "127.0.0.20" });
  assert.equal(out.response.status, 400);
  assert.match(out.data.error, /صيغة/);
  out = await call("/api/requests", { method: "POST", rawBody: "{}", ip: "127.0.0.21", headers: { "content-length": "204801" } });
  assert.equal(out.response.status, 413);
  assert.match(out.data.error, /حجم/);

  out = await call("/");
  assert.equal(out.response.status, 200);
  assert.match(new TextDecoder().decode(out.data), /مقياس منار/);
  out = await call('/admin');
  assert.equal(out.response.status, 200);
  assert.match(new TextDecoder().decode(out.data), /تسجيل دخول الإدارة/);
  out = await call('/vendor/jspdf/jspdf.umd.min.js');
  assert.equal(out.response.status, 200);
  assert(out.data.byteLength > 300000);
  out = await call('/assets/manar-rakaez-wordmark.png');
  assert.equal(out.response.status, 200);
  assert.equal(out.response.headers.get('content-type'), 'image/png');
  assert.deepEqual([...out.data.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  out = await call("/api/config");
  assert.equal(out.data.emailReady, false);
  out = await call("/api/requests", { method: "POST", body: { entityName: "جهة بانتظار الاعتماد", assessorName: "فريق المتابعة", email: "pending@example.test", phone: "", notes: "البريد غير مهيأ" } });
  assert.equal(out.response.status, 201);
  assert.equal(out.data.autoIssued, false);
  assert.equal(out.data.issued, false);
  assert.equal(out.data.status, "pending");
  assert.equal(out.data.emailDelivery.reason, "not_configured");
  const pendingRequestId = out.data.requestId;

  process.env.RESEND_API_KEY = 're_test_only';
  process.env.RESEND_FROM = 'Manar <reports@example.test>';
  let pauseNextEmail = false;
  let pausedEmailCall;
  let resumePausedEmail;
  globalThis.fetch = async (url, init) => {
    const emailCall = { url: String(url), body: JSON.parse(init.body) };
    emailCalls.push(emailCall);
    if (pauseNextEmail) {
      pauseNextEmail = false;
      pausedEmailCall = emailCall;
      return new Promise((resolve) => { resumePausedEmail = resolve; });
    }
    return new Response(JSON.stringify({ id: `message-${emailCalls.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  out = await call("/api/config");
  assert.equal(out.data.emailReady, true);

  out = await call("/api/requests", { method: "POST", body: { entityName: "جهة التجربة", assessorName: "فريق الجودة", email: "quality@example.test", phone: "", notes: "اختبار" } });
  assert.equal(out.response.status, 201);
  assert.equal(out.data.autoIssued, true);
  assert.equal(out.data.issued, true);
  assert.equal(out.data.status, "approved");
  assert.equal(out.data.emailDelivery.sent, true);
  assert.equal(Object.hasOwn(out.data, "accessCode"), false);
  const automaticRequestId = out.data.requestId;

  pauseNextEmail = true;
  const failedRequestCall = call("/api/requests", { method: "POST", body: { entityName: "جهة تعذر بريدها", assessorName: "فريق الجودة", email: "failed@example.test", phone: "", notes: "اختبار التراجع" } });
  while (!resumePausedEmail) await new Promise((resolve) => setTimeout(resolve, 1));
  const failedStagedCode = pausedEmailCall.body.html.match(/MNR-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
  assert.match(failedStagedCode, /^MNR-/);
  const stagedFailure = await testDatabase.prepare(`SELECT r.id request_id, r.status request_status, c.id code_id, c.status code_status
    FROM requests r JOIN access_codes c ON c.request_id = r.id WHERE r.email = ?`).bind("failed@example.test").first();
  assert.equal(stagedFailure.request_status, "pending");
  assert.equal(stagedFailure.code_status, "stopped");
  out = await call("/api/access", { method: "POST", body: { code: failedStagedCode }, ip: "127.0.0.22" });
  assert.equal(out.response.status, 401);
  resumePausedEmail(new Response(JSON.stringify({ name: "validation_error", message: "mock delivery failure" }), { status: 422, headers: { "content-type": "application/json" } }));
  resumePausedEmail = undefined;
  pausedEmailCall = undefined;
  out = await failedRequestCall;
  assert.equal(out.response.status, 201);
  assert.equal(out.data.autoIssued, false);
  assert.equal(out.data.issued, false);
  assert.equal(out.data.status, "pending");
  assert.equal(out.data.emailDelivery.sent, false);
  const failedRequestId = out.data.requestId;
  assert.equal((await testDatabase.prepare("SELECT COUNT(*) count FROM access_codes WHERE request_id = ?").bind(failedRequestId).first()).count, 0);

  out = await call("/api/admin/login", { method: "POST", body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  assert.equal(out.response.status, 200);
  adminCookie = out.response.headers.get("set-cookie").split(";")[0];

  out = await call("/api/admin/overview", { cookie: adminCookie });
  assert.equal(out.response.status, 200);
  assert.equal(out.data.requests.length, 3);
  assert.equal(out.data.codes.length, 1);
  assert.equal(out.data.archivedResults.length, 0);
  assert.equal(Object.hasOwn(out.data.codes[0], "code_ciphertext"), false);
  assert.equal(out.data.requests.find((row) => row.id === automaticRequestId).status, "approved");
  assert.equal(out.data.requests.find((row) => row.id === failedRequestId).status, "pending");
  const automaticCodeId = out.data.codes.find((row) => row.request_id === automaticRequestId).id;

  pauseNextEmail = true;
  const recoveredRequestCall = call("/api/requests", { method: "POST", ip: "127.0.0.23", body: { entityName: "جهة استعادة الإصدار", assessorName: "فريق المتابعة", email: "recover@example.test", phone: "", notes: "اختبار استعادة الرمز المرحلي" } });
  while (!resumePausedEmail) await new Promise((resolve) => setTimeout(resolve, 1));
  const recoveredStagedCode = pausedEmailCall.body.html.match(/MNR-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
  const recoveredState = await testDatabase.prepare(`SELECT r.id request_id, r.status request_status, c.id code_id, c.status code_status
    FROM requests r JOIN access_codes c ON c.request_id = r.id WHERE r.email = ?`).bind("recover@example.test").first();
  assert.equal(recoveredState.request_status, "pending");
  assert.equal(recoveredState.code_status, "stopped");
  assert.equal((await call(`/api/admin/codes/${recoveredState.code_id}/status`, { method: "POST", cookie: adminCookie, body: { status: "active" } })).response.status, 409);
  const recoveredApproval = await call(`/api/admin/requests/${recoveredState.request_id}/approve`, { method: "POST", cookie: adminCookie, body: { sendEmail: true, expiresInDays: 14 } });
  assert.equal(recoveredApproval.response.status, 201);
  assert.equal(recoveredApproval.data.accessCode, recoveredStagedCode);
  resumePausedEmail(new Response(JSON.stringify({ id: "message-recovered-auto" }), { status: 200, headers: { "content-type": "application/json" } }));
  resumePausedEmail = undefined;
  pausedEmailCall = undefined;
  const recoveredRequest = await recoveredRequestCall;
  assert.equal(recoveredRequest.response.status, 201);
  assert.equal(recoveredRequest.data.autoIssued, true);
  assert.equal(recoveredRequest.data.issued, true);
  assert.equal(recoveredRequest.data.status, "approved");
  const recoveredPersisted = await testDatabase.prepare(`SELECT r.status request_status, c.status code_status, COUNT(*) code_count
    FROM requests r JOIN access_codes c ON c.request_id = r.id WHERE r.id = ?`).bind(recoveredState.request_id).first();
  assert.equal(recoveredPersisted.request_status, "approved");
  assert.equal(recoveredPersisted.code_status, "active");
  assert.equal(recoveredPersisted.code_count, 1);

  assert.equal((await call(`/api/admin/codes/${automaticCodeId}/reveal`, { method: "POST" })).response.status, 401);
  out = await call(`/api/admin/codes/${automaticCodeId}/reveal`, { method: "POST", cookie: adminCookie });
  assert.equal(out.response.status, 200);
  assert.match(out.data.accessCode, /^MNR-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const code = out.data.accessCode;

  out = await call(`/api/admin/requests/${pendingRequestId}/approve`, { method: "POST", cookie: adminCookie, body: { sendEmail: true, expiresInDays: 14 } });
  assert.equal(out.response.status, 201);
  assert.match(out.data.accessCode, /^MNR-/);
  assert.equal(out.data.emailDelivery.sent, true);
  assert.equal((await call(`/api/admin/requests/${pendingRequestId}/approve`, { method: "POST", cookie: adminCookie, body: { sendEmail: true, expiresInDays: 14 } })).response.status, 409);

  out = await call("/api/admin/overview", { cookie: adminCookie });
  const pendingCodeId = out.data.codes.find((row) => row.request_id === pendingRequestId).id;
  const automaticCiphertext = await testDatabase.prepare("SELECT code_ciphertext FROM access_codes WHERE id = ?").bind(automaticCodeId).first();
  assert.match(automaticCiphertext.code_ciphertext, /^v1\./);
  assert.equal(automaticCiphertext.code_ciphertext.includes(code), false);
  const otherCiphertext = await testDatabase.prepare("SELECT code_ciphertext FROM access_codes WHERE id = ?").bind(pendingCodeId).first();
  await testDatabase.prepare("UPDATE access_codes SET code_ciphertext = ? WHERE id = ?").bind(otherCiphertext.code_ciphertext, automaticCodeId).run();
  out = await call(`/api/admin/codes/${automaticCodeId}/reveal`, { method: "POST", cookie: adminCookie });
  assert.equal(out.response.status, 409);
  assert.match(out.data.error, /بأمان/);
  await testDatabase.prepare("UPDATE access_codes SET code_ciphertext = NULL WHERE id = ?").bind(pendingCodeId).run();
  out = await call(`/api/admin/codes/${pendingCodeId}/reveal`, { method: "POST", cookie: adminCookie });
  assert.equal(out.response.status, 409);
  assert.match(out.data.error, /قديم/);

  out = await call("/api/access", { method: "POST", body: { code: "bad" } });
  assert.equal(out.response.status, 401);
  assert.match(out.data.error, /MNR-/);
  out = await call("/api/access", { method: "POST", body: {}, ip: "127.0.0.24" });
  assert.equal(out.response.status, 401);
  assert.match(out.data.error, /البريد/);
  out = await call("/api/access", { method: "POST", body: { code: "" }, ip: "127.0.0.25" });
  assert.equal(out.response.status, 401);
  assert.match(out.data.error, /MNR-/);
  out = await call("/api/access", { method: "POST", body: { code: "MNR-" + "A".repeat(200) }, ip: "127.0.0.26" });
  assert.equal(out.response.status, 401);
  assert.match(out.data.error, /MNR-/);
  out = await call("/api/access", { method: "POST", body: { code: "MNR-WRNG-WRNG-WRNG" } });
  assert.equal(out.response.status, 401);
  assert.match(out.data.error, /MNR-/);
  assert.match(out.data.error, /البريد/);
  out = await call("/api/access", { method: "POST", body: { code } });
  assert.equal(out.response.status, 200);
  assessmentCookie = out.response.headers.get("set-cookie").split(";")[0];

  out = await call("/api/assessment", { cookie: assessmentCookie });
  assert.equal(out.response.status, 200);
  const ids = out.data.structure.flatMap((domain) => domain.axes.flatMap((axis) => axis.indicators.map((indicator) => indicator.id)));
  assert.equal(ids.length, 50);

  const payload = {
    entity: { entityName: "جهة التجربة", assessorName: "فريق الجودة", evaluationDate: "2026-09-15" },
    answers: Object.fromEntries(ids.map((id, index) => [id, (index % 5) + 1])),
  };
  out = await call("/api/assessment/draft", { method: "PUT", cookie: assessmentCookie, body: payload });
  assert.equal(out.response.status, 200);

  const concurrentSubmissions = await Promise.all([
    call("/api/assessment/submit", { method: "POST", cookie: assessmentCookie, body: payload }),
    call("/api/assessment/submit", { method: "POST", cookie: assessmentCookie, body: payload }),
  ]);
  const successfulSubmission = concurrentSubmissions.find((submission) => submission.response.status === 201);
  const duplicateSubmission = concurrentSubmissions.find((submission) => submission.response.status === 409);
  assert(successfulSubmission);
  assert(duplicateSubmission);
  assert.match(duplicateSubmission.data.error, /مسبق/);
  out = successfulSubmission;
  assert.equal(out.data.emailDelivery.sent, true);
  const token = new URL(out.data.reportUrl).pathname.split("/").pop();

  out = await call(`/api/reports/${token}`);
  assert.equal(out.response.status, 200);
  assert.equal(out.data.entity.entityName, "جهة التجربة");
  assert.equal(out.data.result.indicatorCount, 50);

  out = await call("/api/admin/overview", { cookie: adminCookie });
  const resultId = out.data.results[0].id;
  out = await call(`/api/admin/results/${resultId}/advisory`, { method: "PATCH", cookie: adminCookie, body: { recommendations: "توصية اختبار", improvementPlan: "خطة اختبار" } });
  assert.equal(out.response.status, 200);

  out = await call(`/api/admin/results/${resultId}/export.xlsx`, { cookie: adminCookie });
  assert.equal(out.response.status, 200);
  assert.deepEqual([...out.data.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

  out = await call(`/api/admin/results/${resultId}/share-link`, { method: "POST", cookie: adminCookie, body: { sendEmail: true } });
  assert.equal(out.response.status, 200);
  assert.equal(out.data.emailDelivery.sent, true);
  const newToken = new URL(out.data.reportUrl).pathname.split("/").pop();
  assert.notEqual(newToken, token);
  assert.equal((await call(`/api/reports/${token}`)).response.status, 404);
  assert.equal((await call(`/api/reports/${newToken}`)).response.status, 200);
  assert.equal(emailCalls.length, 7);
  assert(emailCalls.every((call) => call.url === 'https://api.resend.com/emails'));
  assert.match(emailCalls[0].body.subject, /رمز الدخول/);
  assert.match(emailCalls[1].body.subject, /رمز الدخول/);
  assert.match(emailCalls[2].body.subject, /رمز الدخول/);
  assert.match(emailCalls[3].body.subject, /رمز الدخول/);
  assert.match(emailCalls[4].body.subject, /رمز الدخول/);
  assert.match(emailCalls[5].body.subject, /التقرير النهائي/);
  assert.match(emailCalls[6].body.subject, /التقرير النهائي/);

  out = await call("/api/admin/users", { method: "POST", cookie: adminCookie, body: { email: "supervisor@manar.test", password: "Supervisor-Test-Password-2026!", role: "supervisor" } });
  assert.equal(out.response.status, 201);
  out = await call("/api/admin/login", { method: "POST", body: { email: "supervisor@manar.test", password: "Supervisor-Test-Password-2026!" } });
  assert.equal(out.response.status, 200);
  const supervisorCookie = out.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await call(`/api/admin/codes/${automaticCodeId}/reveal`, { method: "POST", cookie: supervisorCookie })).response.status, 403);
  assert.equal((await call(`/api/admin/results/${resultId}`, { method: "DELETE", cookie: supervisorCookie })).response.status, 403);

  out = await call(`/api/admin/results/${resultId}`, { method: "DELETE", cookie: adminCookie });
  assert.equal(out.response.status, 200);
  assert(out.data.archivedAt);
  assert.equal((await call(`/api/admin/results/${resultId}`, { method: "DELETE", cookie: adminCookie })).response.status, 409);
  assert.equal((await call(`/api/reports/${newToken}`)).response.status, 404);
  assert.equal((await call(`/api/admin/results/${resultId}/advisory`, { method: "PATCH", cookie: adminCookie, body: { recommendations: "لا يجب حفظها", improvementPlan: "" } })).response.status, 404);
  assert.equal((await call(`/api/admin/results/${resultId}/share-link`, { method: "POST", cookie: adminCookie, body: { sendEmail: false } })).response.status, 404);
  assert.equal((await call(`/api/admin/results/${resultId}/export.xlsx`, { cookie: adminCookie })).response.status, 404);
  out = await call("/api/admin/overview", { cookie: adminCookie });
  assert.equal(out.data.results.length, 0);
  assert.equal(out.data.archivedResults.length, 1);
  out = await call("/api/admin/overview", { cookie: supervisorCookie });
  assert.equal(out.data.results.length, 0);
  assert.equal(out.data.archivedResults.length, 0);

  out = await call(`/api/admin/results/${resultId}/restore`, { method: "POST", cookie: adminCookie });
  assert.equal(out.response.status, 200);
  assert(out.data.restoredAt);
  assert.equal((await call(`/api/reports/${newToken}`)).response.status, 200);
  assert.equal((await call(`/api/admin/results/${resultId}/restore`, { method: "POST", cookie: adminCookie })).response.status, 409);
  out = await call("/api/admin/overview", { cookie: adminCookie });
  assert.equal(out.data.results.length, 1);
  assert.equal(out.data.archivedResults.length, 0);
  const invalidToken = 'x'.repeat(43);
  let rateLimited;
  for (let index = 0; index < 58; index++) rateLimited = await call(`/api/reports/${invalidToken}`);
  assert.equal(rateLimited.response.status, 429);

  const originalPrepare = testDatabase.prepare;
  testDatabase.prepare = (sql) => {
    if (String(sql).startsWith("INSERT INTO requests")) throw new Error("FORCED_ROUTE_FAILURE");
    return originalPrepare(sql);
  };
  try {
    out = await call("/api/requests", { method: "POST", ip: "127.0.0.27", body: { entityName: "جهة فشل متعمد", assessorName: "فريق الاختبار", email: "forced-error@example.test" } });
    assert.equal(out.response.status, 500);
    assert.match(out.data.error, /غير متوقع/);
  } finally {
    testDatabase.prepare = originalPrepare;
  }

  console.log("Vercel adapter test passed: awaited error handling, staged email issuance and recovery, concurrent-submit conflict handling, encrypted reveal, role separation, XLSX, link rotation, and reversible result archive.");
} finally {
  closeDatabaseForTests?.();
  globalThis.fetch = originalFetch;
}
