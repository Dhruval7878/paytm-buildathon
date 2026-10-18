// History extension: see lib/ext/history.js for the endpoints.
(function () {
  const OUTCOMES = ['none', 'applied', 'responded', 'interview', 'rejected', 'offer'];
  const fmt = t => t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const getJSON = async url => { const r = await fetch(url); const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || 'Request failed'); return j; };
  const errBox = e => `<div class="empty" style="color:var(--bad)">${esc(e.message || String(e))}</div>`;
  const btn = (label, attrs = '') => `<button type="button" class="ghost" style="padding:4px 10px;font-size:13px" ${attrs}>${label}</button>`;
  const chipCls = s => esc(String(s || '').replace(/[^a-z_-]/gi, ''));

  async function openList() {
    const body = showExt('History of all attempts');
    body.innerHTML = '<div class="empty">Loading...</div>';
    try {
      const { attempts } = await getJSON('/api/history');
      if (!attempts.length) { body.innerHTML = '<div class="empty">No attempts yet. Start an application and it will show up here.</div>'; return; }
      body.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="text-align:left;color:var(--mute);font-size:12px">${['Application', 'Status', 'Outcome', 'Edits', 'Updated', ''].map(h => `<th style="padding:8px;border-bottom:1px solid var(--line);font-weight:600">${h}</th>`).join('')}</tr></thead>
        <tbody>${attempts.map(a => `<tr data-t="${esc(a.resume_token)}">
          <td style="padding:8px;border-bottom:1px solid var(--line);font-weight:600">${esc(a.title)}${a.company ? `<div style="font-weight:400;color:var(--mute);font-size:12px">${esc(a.company)}</div>` : ''}</td>
          <td style="padding:8px;border-bottom:1px solid var(--line)"><span class="chip ${chipCls(a.state)}">${esc(a.state)}</span></td>
          <td style="padding:8px;border-bottom:1px solid var(--line)">${esc(a.outcome)}</td>
          <td style="padding:8px;border-bottom:1px solid var(--line);color:var(--mute)">${a.counts.revisions} edit${a.counts.revisions === 1 ? '' : 's'}</td>
          <td style="padding:8px;border-bottom:1px solid var(--line);color:var(--mute);white-space:nowrap">${esc(fmt(a.updated_at))}</td>
          <td style="padding:8px;border-bottom:1px solid var(--line);white-space:nowrap">${btn('Details', 'data-act="details"')} <a href="/?s=${esc(a.resume_token)}" class="ghost" style="padding:4px 10px;font-size:13px;text-decoration:none;border:1px solid var(--line);border-radius:8px;color:inherit;display:inline-block">Resume</a></td></tr>`).join('')}</tbody></table></div>`;
      body.querySelectorAll('[data-act=details]').forEach(b => b.onclick = () => openDetails(b.closest('tr').dataset.t));
    } catch (e) { body.innerHTML = errBox(e); }
  }

  function finalAnswers(d) {
    const ap = [...d.approvals].reverse().find(a => a.snapshot && Array.isArray(a.snapshot.fields) && a.snapshot.fields.length);
    if (ap) return { src: `Approval snapshot, ${fmt(ap.created_at)}`, rows: ap.snapshot.fields.map(f => ({ label: f.label || f.id, value: f.value })) };
    return { src: 'Latest revision of each answer', rows: d.fields.map(f => ({ label: f.label, value: f.revisions[f.revisions.length - 1].answer })) };
  }

  async function openDetails(token) {
    const body = showExt('Attempt details');
    body.innerHTML = '<div class="empty">Loading...</div>';
    try {
      const d = await getJSON('/api/session/history?token=' + encodeURIComponent(token));
      const s = d.session, fin = finalAnswers(d);
      const label = (r) => r.revision === 1 ? 'AI draft' : (r.review_status === 'skipped' ? 'skipped by you' : 'your edit');
      body.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px">
          <div style="flex:1;min-width:200px"><div style="font-size:18px;font-weight:700">${esc(s.title)}</div>
            <div style="color:var(--mute);font-size:12px;margin-top:2px">Started ${esc(fmt(s.created_at))} &middot; updated ${esc(fmt(s.updated_at))}</div></div>
          <span class="chip ${chipCls(s.state)}">${esc(s.state)}</span>
          <select id="hxOutcome" title="Did they respond?" style="width:auto">${OUTCOMES.map(o => `<option ${o === s.outcome ? 'selected' : ''}>${o}</option>`).join('')}</select>
          <a href="/?s=${esc(s.token)}" style="text-decoration:none;border:1px solid var(--line);border-radius:8px;padding:5px 12px;color:inherit;font-size:13px">Open</a>
          ${btn('Back to all', 'id="hxBack"')}
        </div>
        <div id="hxMsg" style="font-size:12px;color:var(--mute);min-height:16px"></div>
        <h3 style="margin:12px 0 8px;font-size:15px">Final answers <span class="tag">${esc(fin.src)}</span></h3>
        ${fin.rows.length ? fin.rows.map(r => `<div class="field"><label>${esc(r.label)}</label><div style="white-space:pre-wrap">${r.value ? esc(r.value) : '<span style="color:var(--mute)">(empty)</span>'}</div></div>`).join('') : '<div class="empty">No answers were drafted for this attempt.</div>'}
        <h3 style="margin:18px 0 8px;font-size:15px">Revision timeline</h3>
        ${d.fields.length ? d.fields.map(f => `<div class="field"><label>${esc(f.label)}</label>
          ${f.revisions.map((r, i) => {
            const prev = i ? f.revisions[i - 1].answer : null;
            return `<div style="border-left:2px solid var(--line);padding:2px 0 2px 10px;margin:6px 0">
              <div style="font-size:12px;color:var(--mute)"><b style="color:var(--ink)">Revision ${r.revision}: ${label(r)}</b> &middot; ${esc(fmt(r.created_at))} <span class="tag">${esc(r.review_status)}</span></div>
              <div style="white-space:pre-wrap;margin-top:3px">${r.answer ? esc(r.answer) : '<span style="color:var(--mute)">(empty)</span>'}</div>
              ${prev !== null && prev !== r.answer ? `<div style="font-size:12px;color:var(--mute);margin-top:3px">Changed from: <s>${esc(String(prev).slice(0, 200))}${String(prev).length > 200 ? '...' : ''}</s></div>` : ''}
              ${r.missing_info ? `<div style="font-size:12px;color:var(--warn);margin-top:3px">Missing: ${esc(r.missing_info)}</div>` : ''}</div>`;
          }).join('')}</div>`).join('') : '<div class="empty">No drafts were saved for this attempt.</div>'}
        <h3 style="margin:18px 0 8px;font-size:15px">Decisions</h3>
        ${d.approvals.length ? d.approvals.map(a => `<div class="field" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="chip ${a.decision === 'approved' ? 'approved' : a.decision === 'cancelled' ? 'cancelled' : 'reviewing'}">${esc(a.decision)}</span><span style="color:var(--mute);font-size:13px">${esc(fmt(a.created_at))}</span>${a.snapshot && a.snapshot.fields ? `<span class="tag">${a.snapshot.fields.length} answers</span>` : ''}${a.submitted ? '<span class="tag">submitted</span>' : ''}</div>`).join('') : '<div class="empty">No decisions recorded yet.</div>'}
        <details style="margin-top:18px"><summary style="cursor:pointer;font-weight:600;font-size:15px">Transcript (${d.transcript.length} messages)</summary>
          <div style="margin-top:8px">${d.transcript.length ? d.transcript.map(m => `<div style="margin:6px 0"><b>${m.role === 'agent' ? 'Interviewer' : 'You'}:</b> <span style="white-space:pre-wrap">${esc(m.text)}</span></div>`).join('') : '<div class="empty">No transcript.</div>'}</div></details>`;
      $('hxBack').onclick = openList;
      $('hxOutcome').onchange = async e => {
        const m = $('hxMsg'); m.style.color = 'var(--mute)'; m.textContent = 'Saving...';
        try { await post('/api/session/outcome', { token: s.token, outcome: e.target.value }); m.textContent = 'Outcome saved.'; if (typeof loadHistory === 'function') loadHistory(); }
        catch (er) { m.style.color = 'var(--bad)'; m.textContent = er.message; }
      };
    } catch (e) { body.innerHTML = errBox(e) + `<div style="margin-top:8px">${btn('Back to all', 'id="hxBack"')}</div>`; $('hxBack').onclick = openList; }
  }

  // sidebar button
  const nav = $('sideNav');
  if (nav && !$('navHistory')) {
    const b = document.createElement('button');
    b.id = 'navHistory'; b.type = 'button'; b.className = 'ghost'; b.textContent = 'History';
    b.onclick = openList; nav.appendChild(b);
  }

  // add a "Details" link to each sidebar item
  const list = $('histList');
  if (list) {
    const decorate = () => {
      list.querySelectorAll('.hist').forEach(h => {
        const meta = h.querySelector('.meta'), a = h.querySelector('a[href*="?s="]');
        if (!meta || !a || meta.querySelector('.hx-details')) return;
        const tok = (a.getAttribute('href').split('?s=')[1] || '').replace(/[^a-f0-9]/gi, '');
        if (!tok) return;
        const l = document.createElement('a');
        l.href = '#'; l.className = 'hx-details'; l.textContent = 'Details'; l.style.cssText = 'color:var(--accent);font-size:12px';
        l.onclick = e => { e.preventDefault(); e.stopPropagation(); openDetails(tok); };
        meta.appendChild(l);
      });
    };
    new MutationObserver(decorate).observe(list, { childList: true, subtree: true });
    decorate();
  }
})();
