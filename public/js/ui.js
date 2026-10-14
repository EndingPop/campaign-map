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
  // Long messages stay up longer (about 60 ms per character).
  toastTimer = setTimeout(() => { el.hidden = true; }, Math.max(kind === 'error' ? 8000 : 3500, message.length * 60));
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
      } else if (f.type === 'links') {
        // Link list: tick an option to link it; "Hidden" keeps that link from
        // players. value and result: { shown: [ids], hidden: [ids] }.
        const v = f.value || { shown: [], hidden: [] };
        const rows = f.options.map((o) => {
          const linked = v.shown.includes(o.value) || v.hidden.includes(o.value);
          const box = h('input', { type: 'checkbox', checked: linked, 'aria-label': `Link ${o.label}` });
          const hide = h('input', { type: 'checkbox', checked: v.hidden.includes(o.value), disabled: !linked, 'aria-label': `Hide the ${o.label} link from players` });
          box.addEventListener('change', () => { hide.disabled = !box.checked; if (!box.checked) hide.checked = false; });
          const row = h('div', { class: 'link-row', 'data-value': o.value, 'data-label': o.label.toLowerCase() },
            h('label', { class: 'check' }, box, o.swatch ? h('span', { class: 'swatch', html: o.swatch }) : null, o.label),
            h('label', { class: 'check link-hidden' }, hide, 'Hidden'));
          row.read = () => (box.checked ? (hide.checked ? 'hidden' : 'shown') : null);
          return row;
        });
        // Linked options first, so the current links are visible without scrolling.
        rows.sort((a, b) => (b.read() ? 1 : 0) - (a.read() ? 1 : 0));
        const filter = f.options.length > 8 ? h('input', { type: 'search', placeholder: 'Filter', 'aria-label': `Filter ${f.label}`,
          oninput: (e) => { const q = e.target.value.toLowerCase(); rows.forEach((r) => { r.hidden = !!q && !r.dataset.label.includes(q); }); } }) : null;
        input = h('fieldset', { class: 'links' }, h('legend', {}, f.label), filter,
          f.options.length ? h('div', { class: 'link-rows' }, rows) : null);
        input.read = () => {
          const out = { shown: [], hidden: [] };
          rows.forEach((r) => { const st = r.read(); if (st) out[st].push(r.dataset.value); });
          return out;
        };
        inputs[f.name] = input;
        return h('div', { class: 'field' }, input, f.hint ? h('p', { class: 'hint' }, f.hint) : null);
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
        else if (f.type === 'links') out[f.name] = el.read();
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

// The Cancel button comes first, so it has the focus when the dialog opens:
// pressing Enter or Space by accident cancels.
export function confirmDialog(message, confirmLabel = 'Delete', { cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog narrow' });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(h('p', {}, message), h('div', { class: 'dialog-actions' },
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', autofocus: true, onclick: () => close(false) }, cancelLabel),
      h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, confirmLabel)));
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
