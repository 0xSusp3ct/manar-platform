import assert from "node:assert/strict";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.TOKEN_SECRET = "test-token-secret-1234567890-abcdef";
process.env.ADMIN_EMAIL = "owner@manar.test";
process.env.ADMIN_PASSWORD = "Owner-Test-Password-2026!";
process.env.SCORING_PROFILE = "current50";

let closeDatabaseForTests;
try {
  const module = await import("../api/index.js");
  const handler = module.default;
  closeDatabaseForTests = module.closeDatabaseForTests;
  let adminCookie = "";
  let assessmentCookie = "";

  async function call(path, { method = "GET", body, cookie } = {}) {
    const response = await handler.fetch(new Request(`https://manar.test${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        origin: "https://manar.test",
        "x-forwarded-for": "127.0.0.1",
      },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const type = response.headers.get("content-type") || "";
    const data = type.includes("json") ? await response.json() : new Uint8Array(await response.arrayBuffer());
    return { response, data };
  }

  let out = await call("/api/health");
  assert.equal(out.response.status, 200);
  assert.equal(out.data.ok, true);

  out = await call("/");
  assert.equal(out.response.status, 200);
  assert.match(new TextDecoder().decode(out.data), /مقياس منار/);

  out = await call("/api/requests", { method: "POST", body: { entityName: "جهة التجربة", assessorName: "فريق الجودة", email: "quality@example.test", phone: "", notes: "اختبار" } });
  assert.equal(out.response.status, 201);

  out = await call("/api/admin/login", { method: "POST", body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  assert.equal(out.response.status, 200);
  adminCookie = out.response.headers.get("set-cookie").split(";")[0];

  out = await call("/api/admin/overview", { cookie: adminCookie });
  assert.equal(out.response.status, 200);
  assert.equal(out.data.requests.length, 1);

  out = await call(`/api/admin/requests/${out.data.requests[0].id}/approve`, { method: "POST", cookie: adminCookie, body: { sendEmail: true, expiresInDays: 14 } });
  assert.equal(out.response.status, 201);
  assert.match(out.data.accessCode, /^MNR-/);
  const code = out.data.accessCode;

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

  out = await call("/api/assessment/submit", { method: "POST", cookie: assessmentCookie, body: payload });
  assert.equal(out.response.status, 201);
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

  out = await call(`/api/admin/results/${resultId}/share-link`, { method: "POST", cookie: adminCookie, body: { sendEmail: false } });
  assert.equal(out.response.status, 200);
  const newToken = new URL(out.data.reportUrl).pathname.split("/").pop();
  assert.notEqual(newToken, token);
  assert.equal((await call(`/api/reports/${token}`)).response.status, 404);
  assert.equal((await call(`/api/reports/${newToken}`)).response.status, 200);

  console.log("Vercel adapter test passed: persistent SQLite, owner login, approval code, draft, 50-question result, private report, advisory, XLSX export, and link rotation.");
} finally {
  closeDatabaseForTests?.();
}
