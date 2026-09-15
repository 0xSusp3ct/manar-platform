import { Resend } from 'resend';

function client() {
  return process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
}

export function emailReady() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

export async function sendAccessCode({ to, entityName, code, expiresAt, baseUrl }) {
  const resend = client();
  if (!resend || !process.env.RESEND_FROM) return { sent: false, reason: 'not_configured' };
  const expiry = expiresAt ? new Date(expiresAt).toLocaleDateString('ar-SA') : 'غير محدد';
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM,
    to,
    subject: 'رمز الدخول إلى مقياس منار',
    html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#102238"><h2>مقياس منار للتميز التربوي المؤسسي</h2><p>تم اعتماد طلب جهة <strong>${escapeHtml(entityName)}</strong>.</p><p>رمز الدخول:</p><p dir="ltr" style="font-size:24px;font-weight:700;letter-spacing:2px">${escapeHtml(code)}</p><p>ينتهي الرمز في: ${expiry}</p><p><a href="${escapeHtml(baseUrl)}/enter.html">فتح صفحة الدخول</a></p><p>هذا الرمز مخصص للجهة ولا ينبغي مشاركته علنًا.</p></div>`
  });
  if (error) throw new Error(error.message || 'Email delivery failed');
  return { sent: true };
}

export async function sendReportLink({ to, entityName, reportUrl }) {
  const resend = client();
  if (!resend || !process.env.RESEND_FROM) return { sent: false, reason: 'not_configured' };
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM,
    to,
    subject: 'التقرير النهائي لمقياس منار',
    html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#102238"><h2>التقرير النهائي لمقياس منار</h2><p>اكتمل تقييم جهة <strong>${escapeHtml(entityName)}</strong>.</p><p><a href="${escapeHtml(reportUrl)}">عرض التقرير الخاص</a></p><p>الرابط مخصص للعرض فقط. يرجى عدم مشاركته خارج الجهة المعنية.</p></div>`
  });
  if (error) throw new Error(error.message || 'Email delivery failed');
  return { sent: true };
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}
