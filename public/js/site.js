const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    const open = navLinks.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
  });
}

document.querySelectorAll('[data-access-form]').forEach((form) => {
  const code = form.querySelector('[name="code"]');
  const message = form.querySelector('[data-form-message]') || form.parentElement.querySelector('[data-form-message]');
  code.addEventListener('input', () => {
    code.value = code.value.toUpperCase();
    code.removeAttribute('aria-invalid');
    message.classList.add('hidden');
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    showMessage(message, 'جارٍ التحقق من الرمز...', '');
    try {
      const response = await api('/api/access', { method: 'POST', body: { code: code.value } });
      window.location.assign(response.redirect);
    } catch (error) {
      showMessage(message, error.message, 'error');
      code.setAttribute('aria-invalid', 'true');
      code.focus();
      button.disabled = false;
    }
  });
});

const requestForm = document.getElementById('request-form');
const deliveryNote = document.getElementById('request-delivery-note');
const requestSubmit = document.getElementById('request-submit');
if (deliveryNote) {
  api('/api/config').then(({ emailReady }) => {
    if (emailReady) {
      deliveryNote.textContent = 'عند نجاح التسجيل، يُرسل رمز الدخول فورًا إلى البريد الإلكتروني المسجل. لن تظهر إجابات التقييم في الرابط.';
      if (requestSubmit) requestSubmit.textContent = 'التسجيل وإرسال رمز الدخول';
    } else {
      deliveryNote.textContent = 'يُسجل الطلب فورًا ليتابعه مسؤول المقياس ويزوّد الجهة بالرمز عبر قناة آمنة. لن تظهر إجابات التقييم في الرابط.';
    }
  }).catch(() => {});
}
if (requestForm) {
  requestForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = requestForm.querySelector('button[type="submit"]');
    const message = requestForm.querySelector('[data-form-message]');
    const values = Object.fromEntries(new FormData(requestForm));
    button.disabled = true;
    showMessage(message, 'جارٍ إرسال الطلب...', '');
    try {
      const result = await api('/api/requests', { method: 'POST', body: values });
      requestForm.reset();
      showMessage(message, result.message, 'success');
    } catch (error) {
      showMessage(message, error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'تعذر إكمال الطلب.');
  return data;
}

function showMessage(element, text, type) {
  if (!element) return;
  element.textContent = text;
  element.className = `notice${type === 'error' ? ' notice-error' : type === 'success' ? ' notice-success' : ''}`;
}
