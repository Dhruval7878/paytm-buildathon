// Saved state for interviews. Supabase (REST) is the ONLY store: no silent local fallback.
// Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env. The secret key stays on the server; never send it to the browser.
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY;
const CONFIGURED = !!(URL_ && KEY);

function need() {
  if (!CONFIGURED) throw new Error('Supabase is not configured. Add SUPABASE_URL and SUPABASE_SECRET_KEY to .env (Project Settings > API Keys), then restart.');
}

async function rest(method, table, { query = '', body, single = false } = {}) {
  need();
  const res = await fetch(`${URL_}/rest/v1/${table}${query}`, {
    method, signal: AbortSignal.timeout(10000),
    headers: {
      apikey: KEY,
      // new-style sb_secret_* keys are not JWTs: apikey header only. Legacy JWT service keys also want a bearer header.
      ...(KEY.startsWith('sb_') ? {} : { authorization: `Bearer ${KEY}` }),
      'content-type': 'application/json', prefer: 'return=representation',
      ...(single && { accept: 'application/vnd.pgrst.object+json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) { if (single && res.status === 406) return null; throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`); }
  return text ? JSON.parse(text) : null;
}

const SESSION_FIELDS = ['usecase', 'state', 'form_url', 'cursor_field', 'transcript', 'slot_state', 'slots', 'form_meta', 'company', 'role_title', 'outcome', 'outcome_note'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const validToken = t => /^[a-f0-9]{16,64}$/i.test(t || '');   // tokens are hex; rejects anything else before it reaches a URL filter

async function createSession(data) {
  return (await rest('POST', 'sessions', { body: pick(data, SESSION_FIELDS) }))[0];
}

async function getSession(token) {
  if (!validToken(token)) return null;
  return rest('GET', 'sessions', { query: `?resume_token=eq.${token}&limit=1`, single: true });
}

async function updateSession(token, patch) {
  if (!validToken(token)) return null;
  const rows = await rest('PATCH', 'sessions', { query: `?resume_token=eq.${token}`, body: { ...pick(patch, SESSION_FIELDS), updated_at: new Date().toISOString() } });
  return rows?.[0] || null;
}

async function listSessions(limit = 50) {   // history: newest first, without the heavy fields
  const cols = 'id,resume_token,state,form_url,company,role_title,outcome,outcome_note,form_meta,created_at,updated_at';
  return rest('GET', 'sessions', { query: `?select=${cols}&order=updated_at.desc&limit=${limit}` });
}

// Drafts are append-only: an edit inserts revision+1 and leaves the old row.
async function addDraftRevision(sessionId, field_id, answer, review_status = 'draft', evidence_source = null, missing_info = null) {
  // read-then-insert is not atomic: if two edits race for the same revision number, the loser retries with the next one
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await rest('GET', 'drafts', { query: `?session_id=eq.${sessionId}&field_id=eq.${encodeURIComponent(field_id)}&select=revision&order=revision.desc&limit=1` });
    const revision = (last?.[0]?.revision || 0) + 1;
    try { return (await rest('POST', 'drafts', { body: { session_id: sessionId, field_id, revision, answer, review_status, evidence_source, missing_info } }))[0]; }
    catch (e) { if (!/409|23505|duplicate key/i.test(e.message) || attempt === 4) throw e; }
  }
}

async function listDrafts(sessionId) {
  return rest('GET', 'drafts', { query: `?session_id=eq.${sessionId}&order=field_id.asc,revision.asc` });
}

async function addApproval(sessionId, decision, snapshot) {
  return (await rest('POST', 'approvals', { body: { session_id: sessionId, decision, snapshot, submitted: false } }))[0];
}

module.exports = { rest, CONFIGURED, createSession, getSession, updateSession, listSessions, addDraftRevision, listDrafts, addApproval };
