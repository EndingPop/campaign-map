// Small DOM helpers: element builder, form dialogs, confirm, toast.
// User text is always set through textContent, never innerHTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only for trusted, app-built SVG
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  return null;
}

export function formatDate(v) {
  const d = toDate(v);
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

let toastTimer;
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 8000 : 3500);
}

// Turns a thrown Firebase error into a sentence that says what to do.
export function explainError(err) {
  const code = err?.code || '';
  if (code.includes('permission-denied')) return 'That change was refused: your account does not have permission for it.';
  if (code.includes('popup-blocked')) return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
  if (code.includes('popup-closed') || code.includes('cancelled-popup')) return 'Sign-in window closed before finishing.';
  if (code.includes('unauthorized-domain')) return 'This address is not on the Firebase project\'s authorized domains list. Add it in Authentication > Settings.';
  if (code.includes('unavailable') || code.includes('network')) return 'Could not reach the server. Check your connection and try again.';
  return err?.message || String(err);
}

// Generic form dialog. fields: [{name, label, type, value, options, required, hint, rows}]
// Resolves to an object of values, or null if cancelled.
// intro: content shown above the fields; extra: below them.
export function formDialog({ title, fields, submitLabel = 'Save', intro = null, extra = null, danger = null }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog' });
    const inputs = {};
    const body = fields.map((f) => {
      const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
      let input;
      if (f.type === 'select') {
        input = h('select', { id, name: f.name },
          f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { id, name: f.name, rows: String(f.rows || 4) });
        input.value = f.value ?? '';
      } else if (f.type === 'checkbox') {
        input = h('input', { id, name: f.name, type: 'checkbox', checked: !!f.value });
      } else if (f.type === 'checklist') {
        input = h('fieldset', { class: 'checklist' }, h('legend', {}, f.label),
          f.options.map((o) => h('label', { class: 'check' },
            h('input', { type: 'checkbox', value: o.value, checked: (f.value || []).includes(o.value) }),
            o.swatch ? h('span', { class: 'swatch', html: o.swatch }) : null,
            o.label)));
        inputs[f.name] = input;
        return input;
      } else {
        input = h('input', { id, name: f.name, type: f.type || 'text', required: !!f.required, step: f.step || null });
        input.value = f.value ?? '';
      }
      inputs[f.name] = input;
      if (f.type === 'checkbox') return h('label', { class: 'check' }, input, f.label);
      return h('div', { class: 'field' }, h('label', { for: id }, f.label), input, f.hint ? h('p', { class: 'hint' }, f.hint) : null);
    });
    const close = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    const form = h('form', { method: 'dialog', onsubmit: (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        const el = inputs[f.name];
        if (f.type === 'checkbox') out[f.name] = el.checked;
        else if (f.type === 'checklist') out[f.name] = [...el.querySelectorAll('input:checked')].map((i) => i.value);
        else if (f.type === 'number') out[f.name] = el.value === '' ? null : Number(el.value);
        else out[f.name] = el.value.trim();
      }
      close(out);
    } },
    h('h2', {}, title),
    intro,
    body,
    extra,
    h('div', { class: 'dialog-actions' },
      danger ? h('button', { type: 'button', class: 'btn danger', onclick: () => close({ __danger: true }) }, danger) : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, submitLabel)));
    dlg.append(form);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function confirmDialog(message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog narrow' });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(h('p', {}, message), h('div', { class: 'dialog-actions' },
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, 'Cancel'),
      h('button', { type: 'button', class: 'btn danger', onclick: () => close(true) }, confirmLabel)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// Plain dialog with arbitrary content and a Close button.
export function panelDialog(title, content, { wide = false } = {}) {
  const dlg = h('dialog', { class: `dialog${wide ? ' wide' : ''}` });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.append(h('h2', {}, title), content,
    h('div', { class: 'dialog-actions' }, h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn', onclick: close }, 'Close')));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}
