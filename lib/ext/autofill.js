// Resume-driven drafting: for form questions the simple matcher can't fill (essays, "tell us about X"),
// draft an answer ONLY when the stored profile facts (parsed from the user's resume) can support it.
// Everything else is reported as "needs_input" so the interviewer asks about just those.
module.exports = ({ store, llm }) => {
  const clip = (s, n) => String(s ?? '').slice(0, n);

  async function facts() {
    return (await store.rest('GET', 'profile_facts', { query: '?select=key,value&order=key.asc&limit=200' })) || [];
  }

  return {
    // body: { slots: [{id,label,hint}] }  (only the questions that were NOT already filled directly)
    // returns: { drafts: [{slot_id, answer, sources:[keys]}], needs_input: [slot_id] }
    'POST /api/profile/draft': async body => {
      const slots = (Array.isArray(body?.slots) ? body.slots : []).filter(s => s && s.id).slice(0, 30);
      if (!slots.length) return { drafts: [], needs_input: [] };
      const fs = await facts();
      if (!fs.length) return { drafts: [], needs_input: slots.map(s => String(s.id)) };

      const system = `You help someone fill a job application using ONLY facts from their resume. Answer with ONLY JSON:
{"results":[{"slot_id":"...","answerable":true|false,"answer":"...","sources":["fact_key", ...]}]}
Rules:
- answerable=true ONLY if the listed facts directly support a good answer to that exact question. Then write the answer in the first person, plain and specific, at most 70 words, using ONLY information in those facts. Never invent employers, numbers, outcomes, tools or dates. Keep numbers and units exactly as written. List the fact keys you used in "sources".
- answerable=false for anything about motivation, goals, preferences, opinions, why this particular company, culture fit, availability or expectations that the facts do not state, and for anything the facts do not cover. Do not guess. Do not write a generic answer. For those leave answer empty.
- Never use gendered pronouns for the applicant. Use first person.
- If unsure, answerable=false.`;
      const user = 'FACTS (key: value):\n' + fs.map(f => `- ${f.key}: ${clip(f.value, 500)}`).join('\n') +
        '\n\nQUESTIONS:\n' + slots.map(s => `- slot_id=${s.id} | question=${clip(s.label, 200)} | hint=${clip(s.hint, 200)}`).join('\n');

      let results = [];
      try {
        const r = await llm({ role: 'brief', system, user, maxTokens: 1500, temperature: 0.2 });
        results = Array.isArray(r?.results) ? r.results : [];
      } catch (e) { /* drafting is best-effort: on failure every question simply goes to the interview */ }

      const known = new Set(fs.map(f => f.key)), ids = new Set(slots.map(s => String(s.id)));
      const drafts = [];
      for (const x of results) {
        const sid = String(x?.slot_id || '');
        const sources = (Array.isArray(x?.sources) ? x.sources : []).map(String).filter(k => known.has(k));
        // a draft must be grounded: answerable, non-empty, and citing at least one real stored fact
        if (x?.answerable === true && ids.has(sid) && clip(x.answer, 800).trim() && sources.length && !drafts.some(d => d.slot_id === sid)) {
          drafts.push({ slot_id: sid, answer: clip(x.answer, 800).trim(), sources });
        }
      }
      const done = new Set(drafts.map(d => d.slot_id));
      return { drafts, needs_input: slots.map(s => String(s.id)).filter(id => !done.has(id)) };
    }
  };
};
