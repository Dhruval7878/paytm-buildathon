// History of all previous tries: list of sessions + full detail of one (drafts by revision, approvals, transcript).
const TOKEN = /^[a-f0-9]{16,64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const titleOf = s => {
  let host = '';
  try { host = s.form_url ? new URL(s.form_url).hostname : ''; } catch {}
  return (s.form_meta && s.form_meta.title) || s.role_title || host || 'Application';
};

module.exports = ctx => ({
  'GET /api/history': async () => {
    const { rest } = ctx.store;
    const cols = 'id,resume_token,state,form_url,company,role_title,outcome,outcome_note,form_meta,created_at,updated_at';
    const sessions = await rest('GET', 'sessions', { query: `?select=${cols}&order=updated_at.desc&limit=500` }) || [];
    const counts = {};
    try {
      const [drafts, approvals] = await Promise.all([
        rest('GET', 'drafts', { query: '?select=session_id,revision&limit=10000' }),
        rest('GET', 'approvals', { query: '?select=session_id&limit=10000' })
      ]);
      for (const d of drafts || []) { const c = counts[d.session_id] ||= { drafts: 0, revisions: 0, approvals: 0 }; c.drafts++; if (d.revision > 1) c.revisions++; }
      for (const a of approvals || []) { const c = counts[a.session_id] ||= { drafts: 0, revisions: 0, approvals: 0 }; c.approvals++; }
    } catch {}
    return {
      attempts: sessions.map(s => ({
        resume_token: s.resume_token, title: titleOf(s), state: s.state, outcome: s.outcome, outcome_note: s.outcome_note,
        company: s.company, form_url: s.form_url, created_at: s.created_at, updated_at: s.updated_at,
        counts: counts[s.id] || { drafts: 0, revisions: 0, approvals: 0 }
      }))
    };
  },

  'GET /api/session/history': async (_, url) => {
    const token = url.searchParams.get('token');
    if (!TOKEN.test(token || '')) throw new Error('Invalid token');
    const sess = await ctx.store.getSession(token);
    if (!sess) throw new Error('That link does not match a saved session.');
    if (!UUID.test(sess.id)) throw new Error('Bad session id');
    const [drafts, approvals] = await Promise.all([
      ctx.store.rest('GET', 'drafts', { query: `?session_id=eq.${sess.id}&order=created_at.asc,revision.asc` }),
      ctx.store.rest('GET', 'approvals', { query: `?session_id=eq.${sess.id}&order=created_at.asc` })
    ]);
    const labels = {};
    for (const s of sess.slots || []) labels[s.id] = s.label || s.id;
    const byField = new Map();
    for (const d of drafts || []) {
      if (!byField.has(d.field_id)) byField.set(d.field_id, { field_id: d.field_id, label: labels[d.field_id] || d.field_id, revisions: [] });
      byField.get(d.field_id).revisions.push({ revision: d.revision, answer: d.answer, review_status: d.review_status,
        evidence_source: d.evidence_source, missing_info: d.missing_info, created_at: d.created_at });
    }
    const fields = [...byField.values()];
    for (const f of fields) f.revisions.sort((a, b) => a.revision - b.revision);
    // keep question order from the form
    const order = (sess.slots || []).map(s => s.id);
    fields.sort((a, b) => (order.indexOf(a.field_id) + 1 || 999) - (order.indexOf(b.field_id) + 1 || 999));
    return {
      session: {
        token: sess.resume_token, title: titleOf(sess), state: sess.state, outcome: sess.outcome, outcome_note: sess.outcome_note,
        company: sess.company, role_title: sess.role_title, form_url: sess.form_url, usecase: sess.usecase,
        created_at: sess.created_at, updated_at: sess.updated_at, slots: sess.slots || []
      },
      fields,
      approvals: (approvals || []).map(a => ({ id: a.id, decision: a.decision, submitted: a.submitted, created_at: a.created_at, snapshot: a.snapshot })),
      transcript: Array.isArray(sess.transcript) ? sess.transcript : []
    };
  }
});
