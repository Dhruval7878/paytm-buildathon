// Profile extension: see lib/ext/profile.js for the endpoints.
(function () {
  const nav = $('sideNav');
  if (!nav) return;
  const btn = document.createElement('button');
  btn.textContent = 'My profile';
  btn.onclick = openProfile;
  nav.appendChild(btn);

  const fmt = d => { try { return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } };
  const IN = 'width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:13px;box-sizing:border-box';
  const BTN = 'padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:12px;cursor:pointer';
  let facts = [], proposed = [], root;

  async function openProfile() {
    root = showExt('My profile');
    root.innerHTML = '<div class="empty">Loading...</div>';
    await load();
  }
  async function load() {
    try {
      const r = await fetch('/api/profile'); const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      facts = j.facts || [];
      render();
    } catch (e) { root.innerHTML = `<div class="empty" style="color:var(--bad)">Could not load profile: ${esc(e.message)}</div>`; }
  }

  function render() {
    const rows = facts.map((f, i) => `<div class="field" data-i="${i}" style="display:grid;grid-template-columns:150px 1fr;gap:8px 12px;align-items:start">
      <div><b style="font-size:13px;word-break:break-all">${esc(f.key)}</b><div style="margin-top:4px">${f.confirmed_at
        ? `<span class="tag stated" style="margin-left:0">confirmed ${esc(fmt(f.confirmed_at))}</span>` : `<span class="tag inferred" style="margin-left:0">unconfirmed</span>`}</div></div>
      <div><textarea class="pv" rows="${f.value.length > 90 ? 3 : 1}" style="${IN};resize:vertical">${esc(f.value)}</textarea>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          <button class="pconf" style="${BTN}">Confirm</button><button class="psave" style="${BTN}">Save</button><button class="pdel" style="${BTN};color:var(--bad)">Delete</button>
          <span class="pmsg" style="font-size:12px;color:var(--mute);align-self:center"></span></div></div></div>`).join('');
    root.innerHTML = `<div style="max-width:820px">
      <p style="color:var(--mute);font-size:13px;margin:0 0 14px">Use fictional details while testing. Everything here is stored in your Supabase project.</p>
      <h3 style="margin:0 0 8px;font-size:15px">Saved facts <span class="chip">${facts.length}</span></h3>
      ${rows || '<div class="empty">No facts saved yet. Import from a resume below or add one.</div>'}
      <div class="field" style="display:grid;grid-template-columns:150px 1fr;gap:8px 12px">
        <input id="pnk" placeholder="key e.g. phone" style="${IN}"><div style="display:flex;gap:8px"><input id="pnv" placeholder="value" style="${IN}"><button id="pnadd" style="${BTN};white-space:nowrap">Add fact</button></div>
        <div id="pnmsg" style="grid-column:1/3;font-size:12px;color:var(--mute)">Keys: lowercase letters, digits, underscores.</div></div>
      <h3 style="margin:24px 0 8px;font-size:15px">Import from resume</h3>
      <div class="card" style="padding:14px">
        <textarea id="prtext" rows="8" maxlength="20000" placeholder="Paste your resume as plain text (max 20,000 characters)" style="${IN};resize:vertical"></textarea>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center"><button id="prext" style="${BTN}">Extract</button><span id="prmsg" style="font-size:12px;color:var(--mute)"></span></div>
        <div id="prprop"></div></div></div>`;
    root.querySelectorAll('.field[data-i]').forEach(el => {
      const f = facts[el.dataset.i], msg = el.querySelector('.pmsg'), val = () => el.querySelector('.pv').value;
      const run = async fn => { msg.style.color = 'var(--mute)'; msg.textContent = '...'; try { await fn(); } catch (e) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; } };
      el.querySelector('.psave').onclick = () => run(async () => { await post('/api/profile/save', { facts: [{ key: f.key, value: val() }] }); await load(); });
      el.querySelector('.pconf').onclick = () => run(async () => { await post('/api/profile/save', { facts: [{ key: f.key, value: val() }], confirm: true }); await load(); });
      el.querySelector('.pdel').onclick = () => { if (confirm(`Delete "${f.key}"?`)) run(async () => { await post('/api/profile/delete', { key: f.key }); await load(); }); };
    });
    $('pnadd').onclick = async () => {
      const m = $('pnmsg'); m.style.color = 'var(--mute)';
      try { await post('/api/profile/save', { facts: [{ key: $('pnk').value.trim().toLowerCase(), value: $('pnv').value, source: 'manual' }] }); await load(); }
      catch (e) { m.style.color = 'var(--bad)'; m.textContent = e.message; }
    };
    $('prext').onclick = async () => {
      const m = $('prmsg'), b = $('prext'); m.style.color = 'var(--mute)'; m.textContent = 'Extracting...'; b.disabled = true;
      try { proposed = (await post('/api/profile/extract', { text: $('prtext').value })).facts; m.textContent = proposed.length ? '' : 'No facts found in that text.'; renderProposed(); }
      catch (e) { m.style.color = 'var(--bad)'; m.textContent = e.message; }
      b.disabled = false;
    };
    renderProposed();
  }

  function renderProposed() {
    const box = $('prprop'); if (!box) return;
    if (!proposed.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div style="margin-top:12px">${proposed.map((p, i) => `<div class="field" data-p="${i}" style="display:grid;grid-template-columns:150px 1fr auto;gap:8px 12px;align-items:start">
      <b style="font-size:13px;word-break:break-all">${esc(p.key)}</b>
      <div><textarea rows="${p.value.length > 90 ? 3 : 1}" style="${IN};resize:vertical">${esc(p.value)}</textarea>
        ${p.evidence ? `<div style="font-size:11px;color:var(--mute);margin-top:4px">Evidence: &ldquo;${esc(p.evidence)}&rdquo;</div>` : ''}</div>
      <button class="prm" style="${BTN}">Remove</button></div>`).join('')}
      <div style="display:flex;gap:8px;align-items:center"><button id="prsave" style="${BTN};background:var(--accent);color:#fff;border-color:var(--accent)">Save to profile</button>
      <label style="font-size:12px;color:var(--mute)"><input type="checkbox" id="prconf"> Mark as confirmed</label><span id="prsmsg" style="font-size:12px"></span></div></div>`;
    box.querySelectorAll('[data-p]').forEach(el => {
      const i = +el.dataset.p;
      el.querySelector('textarea').oninput = e => { proposed[i].value = e.target.value; };
      el.querySelector('.prm').onclick = () => { proposed.splice(i, 1); renderProposed(); };
    });
    $('prsave').onclick = async () => {
      const m = $('prsmsg'); m.style.color = 'var(--mute)'; m.textContent = 'Saving...';
      try { await post('/api/profile/save', { facts: proposed.map(p => ({ key: p.key, value: p.value, source: 'resume' })), confirm: $('prconf').checked }); proposed = []; await load(); }
      catch (e) { m.style.color = 'var(--bad)'; m.textContent = e.message; }
    };
  }
})();
