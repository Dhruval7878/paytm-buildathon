// Profile extension: stored user facts (profile_facts) used to pre-fill application answers.
const KEY_RE = /^[a-z0-9_]{1,40}$/;
const FIRST = ['full_name', 'email', 'phone', 'location'];
const q = encodeURIComponent;

const ESSAY = /\b(why|goal|aspir|motivat|tell us|describe|explain|passion|strength|weakness|cover letter|something you|proud|challenge|vision|what makes|how would|how do you|opportunit|yourself)\b|career/i;
// [fact key, regex over "label id"] : cheap deterministic rules
const RULES = [
  ['email', /e-?mail/],
  ['phone', /\b(mobile|phone|whatsapp|contact (no|num))/],
  ['linkedin', /linked-?in/],
  ['github', /git-?hub/],
  ['portfolio', /\b(portfolio|personal (site|website)|website url)\b/],
  ['years_experience', /(years?|yrs?) of (work |relevant |total |professional )?experience|total experience|experience in years|years_experience/],
  ['notice_period', /notice/],
  ['expected_ctc', /(expected|desired|expectation).{0,20}(salary|ctc|compensation|pay)|(salary|ctc|compensation).{0,20}expect/],
  ['work_authorization', /work (authori[sz]ation|permit)|visa|authori[sz]ed to work/],
  ['location', /\b(current )?(city|location)\b|where are you (based|located)/],
  ['full_name', /^(?!.*(company|organi[sz]ation|referr|college|school|friend|manager|reference|university|institute)).*\b(full ?name|your name|candidate name|applicant name|name)\b/],
];

function order(a, b) {
  const ia = FIRST.indexOf(a.key), ib = FIRST.indexOf(b.key);
  if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

module.exports = ctx => {
  const { store, llm } = ctx;
  const list = async () => (await store.rest('GET', 'profile_facts', { query: '?select=key,value,source,confirmed_at,updated_at' })).sort(order);

  async function upsert(f, confirm) {
    const key = String(f?.key || '').trim().toLowerCase();
    const value = String(f?.value ?? '').trim();
    if (!KEY_RE.test(key)) throw new Error(`Invalid key "${key}": use lowercase letters, digits and underscores (max 40)`);
    if (value.length < 1 || value.length > 2000) throw new Error(`Value for "${key}" must be 1 to 2000 characters`);
    const now = new Date().toISOString();
    const ex = (await store.rest('GET', 'profile_facts', { query: `?key=eq.${q(key)}&limit=1` }))[0];
    const source = f.source ? String(f.source).slice(0, 40) : (ex?.source || 'resume');
    const confirmed_at = confirm ? now : (ex && ex.value === value ? ex.confirmed_at : null);
    const row = { value, source, confirmed_at, updated_at: now };
    if (ex) return (await store.rest('PATCH', 'profile_facts', { query: `?key=eq.${q(key)}`, body: row }))[0];
    try {
      return (await store.rest('POST', 'profile_facts', { body: { key, ...row } }))[0];
    } catch (e) {   // raced with another insert: fall back to update
      return (await store.rest('PATCH', 'profile_facts', { query: `?key=eq.${q(key)}`, body: row }))[0];
    }
  }

  const keyOf = b => { const k = String(b?.key || '').trim().toLowerCase(); if (!KEY_RE.test(k)) throw new Error('Invalid key'); return k; };

  return {
    'GET /api/profile': async () => ({ facts: await list() }),

    'POST /api/profile/extract': async body => {
      const text = String(body?.text || '').trim().slice(0, 20000);
      if (text.length < 20) throw new Error('Paste the resume text first');
      const system = `You extract profile facts from a resume. Answer ONLY with JSON: {"facts":[{"key":"...","value":"...","evidence":"..."}]}.
Rules:
- Use ONLY what is written in the resume. Keep values exactly as written: numbers and units unchanged, nothing added or converted (keep "1.5 years" as is).
- Never invent or infer. Skip anything that is absent. Do not use gendered pronouns.
- Prefer these snake_case keys when applicable: full_name, email, phone, location, linkedin, github, portfolio, headline, current_role, current_company, years_experience, education, skills, languages, notice_period, expected_ctc, work_authorization, plus project_1, project_2, ... (one concise factual line each, with an outcome or number only if the resume states it). Other snake_case keys are allowed if clearly useful.
- "evidence" is a short verbatim snippet copied from the resume supporting the value.
- Each key at most once.`;
      const r = await llm({ role: 'track', system, user: 'RESUME:\n' + text, maxTokens: 2500, temperature: 0 });
      const seen = new Set(), facts = [];
      for (const f of (Array.isArray(r?.facts) ? r.facts : [])) {
        const key = String(f?.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
        const value = String(f?.value ?? '').trim().slice(0, 2000);
        if (!KEY_RE.test(key) || !value || seen.has(key)) continue;
        seen.add(key);
        facts.push({ key, value, evidence: String(f?.evidence || '').trim().slice(0, 300) });
      }
      return { facts };
    },

    'POST /api/profile/save': async body => {
      const items = Array.isArray(body?.facts) ? body.facts : [];
      if (!items.length) throw new Error('No facts to save');
      if (items.length > 100) throw new Error('Too many facts');
      for (const f of items) { const k = String(f?.key || '').trim().toLowerCase(), v = String(f?.value ?? '').trim(); if (!KEY_RE.test(k) || v.length < 1 || v.length > 2000) throw new Error(`Invalid fact "${k}"`); }
      const saved = [];
      for (const f of items) saved.push(await upsert(f, body.confirm === true));
      return { facts: saved };
    },

    'POST /api/profile/confirm': async body => {
      const key = keyOf(body);
      const rows = await store.rest('PATCH', 'profile_facts', { query: `?key=eq.${q(key)}`, body: { confirmed_at: new Date().toISOString() } });
      if (!rows.length) throw new Error('No such fact');
      return { fact: rows[0] };
    },

    'POST /api/profile/delete': async body => {
      await store.rest('DELETE', 'profile_facts', { query: `?key=eq.${q(keyOf(body))}` });
      return { ok: true };
    },

    'POST /api/profile/prefill': async body => {
      const slots = (Array.isArray(body?.slots) ? body.slots : []).filter(s => s && s.id).slice(0, 60);
      const facts = await list();
      if (!facts.length || !slots.length) return { matches: [] };
      const byKey = Object.fromEntries(facts.map(f => [f.key, f]));
      const matches = [], rest = [];
      for (const s of slots) {
        const label = String(s.label || ''), hint = String(s.hint || '');
        const text = `${label} ${s.id}`.toLowerCase().replace(/[_-]+/g, ' ');
        if (ESSAY.test(label) || ESSAY.test(hint) && !RULES.some(([, re]) => re.test(text))) continue;   // open-ended: never pre-fill
        const rule = RULES.find(([k, re]) => re.test(text));
        if (rule) {
          const f = byKey[rule[0]];
          if (f) matches.push({ slot_id: s.id, key: f.key, value: f.value, confidence: 'high', reason: `Question asks for ${f.key.replace(/_/g, ' ')}` });
          continue;
        }
        rest.push(s);
      }
      if (rest.length) {
        try {
          const system = `You map job-application form questions to stored profile facts. Answer ONLY with JSON: {"matches":[{"slot_id":"...","key":"...","reason":"..."}]}.
Map a question to a fact ONLY when the question clearly and directly asks for exactly that fact. If unsure, omit it. Never map open-ended or essay questions (motivation, goals, "tell us about...", opinions). Do not output values, only the fact key exactly as listed. Questions like "Source" or "How did you hear about us" or "Interested in" have no matching fact unless a fact key clearly equals it.`;
          const user = 'FACT KEYS: ' + facts.map(f => f.key).join(', ') + '\nQUESTIONS:\n' + rest.map(s => `- id=${s.id} | label=${s.label || ''} | hint=${s.hint || ''}`).join('\n');
          const r = await llm({ role: 'track', system, user, maxTokens: 800, temperature: 0 });
          const ids = new Set(rest.map(s => String(s.id)));
          for (const m of (Array.isArray(r?.matches) ? r.matches : [])) {
            const f = byKey[String(m?.key || '')];
            if (f && ids.has(String(m.slot_id)) && !matches.some(x => x.slot_id === m.slot_id))
              matches.push({ slot_id: m.slot_id, key: f.key, value: f.value, confidence: 'medium', reason: String(m.reason || '').slice(0, 200) });
          }
        } catch (e) { /* LLM is best-effort; rule matches still returned */ }
      }
      return { matches };
    },
  };
};
