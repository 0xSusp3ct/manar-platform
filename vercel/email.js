import { Resend } from 'resend';

export function emailReady(env) {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM);
}

export async function sendAccessCode(env, { to, entityName, code, expiresAt, baseUrl }) {
  if (!emailReady(env)) return { sent: false, reason: 'not_configured' };
  const expiry = expiresAt ? new Date(expiresAt).toLocaleDateString('ar-SA') : 'غير محدد';
  return send(env, {
    to,
    subject: 'رمز الدخول إلى مقياس منار',
    html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#2b4052"><h2>مقياس منار للتميز التربوي المؤسسي</h2><p>تم اعتماد طلب جهة <strong>${escapeHtml(entityName)}</strong>.</p><p>رمز الدخول:</p><p dir="ltr" style="font-size:24px;font-weight:700;letter-spacing:2px">${escapeHtml(code)}</p><p>ينتهي الرمز في: ${escapeHtml(expiry)}</p><p><a href="${escapeHtml(baseUrl)}/enter.html">فتح صفحة الدخول</a></p><p>هذا الرمز مخصص للجهة ولا ينبغي مشاركته علنًا.</p></div>`,
  });
}

export async function sendReportLink(env, { to, entityName, reportUrl }) {
  if (!emailReady(env)) return { sent: false, reason: 'not_configured' };
  return send(env, {
    to,
    subject: 'التقرير النهائي لمقياس منار',
    html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#2b4052"><h2>التقرير النهائي لمقياس منار</h2><p>اكتمل تقييم جهة <strong>${escapeHtml(entityName)}</strong>.</p><p><a href="${escapeHtml(reportUrl)}">عرض التقرير الخاص</a></p><p>الرابط مخصص للعرض فقط. يرجى عدم مشاركته خارج الجهة المعنية.</p></div>`,
  });
}

async function send(env, { to, subject, html }) {
  try {
    const { data, error } = await new Resend(env.RESEND_API_KEY).emails.send({
      from: env.RESEND_FROM,
      to: [to],
      subject,
      html,
    });
    if (error || !data?.id) {
      console.error('Manar email delivery failed', error?.name || 'no_message_id');
      return { sent: false, reason: 'delivery_failed' };
    }
    return { sent: true };
  } catch (error) {
    console.error('Manar email delivery failed', error?.name || 'network_error');
    return { sent: false, reason: 'delivery_failed' };
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}
