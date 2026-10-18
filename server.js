// Voice Interviewer Kit: zero-dependency server. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const usecases = require('./usecases');
const { readForm } = require('./lib/readForm');

// ---- tiny .env loader -------------------------------------------------------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#\n]*?)\s*(#.*)?$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}
const store = require('./lib/store');   // after the .env loader: it reads SUPABASE_* at load time

// ---- providers & roles --------------------------------------------------------
// Providers: anthropic | openai | cloudflare (Workers AI) | gemini (multiple keys rotate on rate limits).
// Each ROLE (turn = fast spoken reply, track = background slot tracking, brief = final summary) can use a different provider.
const SARVAM = process.env.SARVAM_KEY || process.env.SARVAM_API_KEY;
const GEMINI_KEYS = Object.keys(process.env).filter(k => /^GEMINI_API_KEY(_\d+)?$/.test(k)).sort().map(k => process.env[k]).filter(Boolean);
const HAS = { anthropic: !!process.env.ANTHROPIC_API_KEY, openai: !!process.env.OPENAI_API_KEY, cloudflare: !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID), gemini: GEMINI_KEYS.length > 0, sarvam: !!SARVAM };
const PROVIDER = process.env.LLM_PROVIDER || (HAS.anthropic ? 'anthropic' : HAS.openai ? 'openai' : HAS.cloudflare ? 'cloudflare' : HAS.gemini ? 'gemini' : 'anthropic');
const DEFAULTS = {   // [fast/turn, brief]
  anthropic:  ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'],
  openai:     ['gpt-4o-mini', 'gpt-4o'],
  cloudflare: ['@cf/meta/llama-3.2-3b-instruct', '@cf/openai/gpt-oss-120b'],   // 3B ~1s but weak; 70B tracks well but 6-8s
  sarvam:     ['sarvam-105b-conversations', 'sarvam-105b'],
  gemini:     ['gemini-3.5-flash-lite', 'gemini-3.5-flash']   // 3.1-flash-lite was erratic (1s then 30s); 3.5-flash-lite steady 1-3s
};
const role = (name, fallbackProvider, modelIdx, special) => {
  const provider = process.env[`${name}_PROVIDER`] || fallbackProvider;
  return { provider, model: process.env[`${name}_MODEL`] || special?.[provider] || DEFAULTS[provider][modelIdx] };
};
// Best free combo: Gemini writes the spoken reply (fast + natural), Cloudflare 70B tracks slots in the background.
const TURN_P = HAS.sarvam ? 'sarvam' : PROVIDER === 'cloudflare' && HAS.gemini ? 'gemini' : PROVIDER;
const ROLES = {
  turn:  role('TURN', TURN_P, 0),
  track: role('TRACK', PROVIDER, 0, { cloudflare: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
  brief: role('BRIEF', PROVIDER === 'cloudflare' && HAS.gemini ? 'gemini' : PROVIDER, 1)
};
// Brief fallback chain: if the primary model is overloaded ("high demand"), try other providers/models before giving up.
ROLES.briefChain = ['brief'];
[['sarvam', 'sarvam-105b'], ['cloudflare', '@cf/openai/gpt-oss-120b'], ['gemini', 'gemini-2.5-flash'], ['anthropic', 'claude-sonnet-5-5'], ['openai', 'gpt-4o']].forEach(([provider, model], i) => {
  if (HAS[provider] && !(provider === ROLES.brief.provider && model === ROLES.brief.model)) { ROLES['brief' + (i + 2)] = { provider, model }; ROLES.briefChain.push('brief' + (i + 2)); }
});
// Tracker fallback chain: if the primary tracker is out of quota or down, other providers take over automatically.
ROLES.trackChain = ['track'];
[['gemini', 'gemini-3.5-flash-lite'], ['sarvam', 'sarvam-105b'], ['anthropic', 'claude-haiku-4-5-20251001'], ['openai', 'gpt-4o-mini'], ['cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast']].forEach(([provider, model], i) => {
  if (HAS[provider] && provider !== ROLES.track.provider) { ROLES['track' + (i + 2)] = { provider, model }; ROLES.trackChain.push('track' + (i + 2)); }
});
// If the reply model fails, a different provider answers instead of the user hearing "say that again".
ROLES.turnFallback = (() => {
  const p = ['gemini', 'cloudflare', 'anthropic', 'openai', 'sarvam'].find(x => HAS[x] && x !== ROLES.turn.provider);
  return p ? { provider: p, model: DEFAULTS[p][0] } : ROLES.turn;
})();
const SPLIT = (process.env.SPLIT_TURN ?? (ROLES.turn.provider !== ROLES.track.provider || ROLES.turn.model !== ROLES.track.model ? '1' : '0')) === '1';
const KEY = HAS[ROLES.turn.provider];
const TURN_MODEL = ROLES.turn.model, TRACK_MODEL = ROLES.track.model, BRIEF_MODEL = ROLES.brief.model;
const PORT = process.env.PORT || 3000;

// ---- LLM adapter ------------------------------------------------------------------
let geminiNext = 0;
async function callProvider(provider, { system, user, model, maxTokens, temperature, timeoutMs }) {
  if (!HAS[provider]) throw new Error(`No credentials for provider "${provider}". Check .env`);
  if (provider === 'gemini') {
    let lastErr;
    for (let i = 0; i < GEMINI_KEYS.length; i++) {            // rotate keys on rate limit / overload
      const key = GEMINI_KEYS[(geminiNext + i) % GEMINI_KEYS.length];
      let res, data;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          signal: AbortSignal.timeout(timeoutMs),   // a hung call must never stall the conversation (short for live replies, long for the brief)
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature, responseMimeType: 'application/json',
              ...(process.env.GEMINI_THINKING_BUDGET !== undefined && { thinkingConfig: { thinkingBudget: +process.env.GEMINI_THINKING_BUDGET } }) } })
        });
        data = await res.json();
      } catch (e) { lastErr = new Error(`Gemini timeout/network: ${e.name}`); continue; }   // try the next key
      if (res.ok) {
        geminiNext = (geminiNext + i + 1) % GEMINI_KEYS.length;   // spread load across keys
        return (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      }
      lastErr = new Error(data.error?.message || `Gemini error ${res.status}`);
    }
    throw lastErr;
  }
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Anthropic error ${res.status}`);
    return data.content.map(c => c.text || '').join('');
  }
  if (provider === 'sarvam') {   // reasoning models: give them room, or `content` comes back null
    const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'api-subscription-key': SARVAM },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, max_tokens: Math.max(maxTokens, 1500), temperature, reasoning_effort: null,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Sarvam error ${res.status}`);
    return data.choices?.[0]?.message?.content ?? '';
  }
  // openai | cloudflare: OpenAI-compatible chat completions
  const url = provider === 'cloudflare'
    ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`
    : `${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider === 'cloudflare' ? process.env.CLOUDFLARE_API_TOKEN : process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature,
      // JSON mode isn't guaranteed on every Cloudflare model; parseJSON() copes with plain text anyway.
      ...(provider === 'openai' && { response_format: { type: 'json_object' } }),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || data.errors?.[0]?.message || `LLM error ${res.status}`);
  return data.choices?.[0]?.message?.content ?? '';
}

const TIMEOUT_MS = { turn: +process.env.TURN_TIMEOUT_MS || 8000, turnFallback: 8000, track: 30000, brief: 60000 };
// A provider that reports "quota / rate limit" is skipped for 15 minutes so every call doesn't waste time failing first.
const COOLDOWN = {};
const QUOTA_RE = /daily free allocation|neurons|quota|rate.?limit|resource.?exhausted|too many requests|\b429\b|insufficient|credit/i;
async function llm({ role: r = 'turn', system, user, maxTokens = 1500, temperature = 0.6, raw = false }) {
  const chain = r === 'track' ? ROLES.trackChain : [r];
  const live = chain.filter(n => !(COOLDOWN[ROLES[n].provider] > Date.now()));
  let lastErr;
  for (const n of (live.length ? live : chain)) {
    const { provider, model } = ROLES[n];
    try {
      const text = await callProvider(provider, { system, user, model, maxTokens, temperature, timeoutMs: TIMEOUT_MS[n] || TIMEOUT_MS[r] || 60000 });
      return raw ? text : parseJSON(text);
    } catch (e) {
      lastErr = e;
      if (QUOTA_RE.test(e.message)) { COOLDOWN[provider] = Date.now() + 15 * 60 * 1000; console.error(`${provider} looks out of quota; skipping it for 15 minutes`); }
      if (chain.length === 1) throw e;
      console.error(`${r} via ${provider}/${model} failed (${e.message.slice(0, 90)}); trying the next provider`);
    }
  }
  throw lastErr;
}

function parseJSON(text) {
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');   // strip reasoning traces some models emit
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('Model did not return JSON: ' + text.slice(0, 200));
  return JSON.parse(text.slice(a, b + 1));
}

// ---- prompts -----------------------------------------------------------------
const slotList = slots => slots.map(s => `- ${s.id}: ${s.label} (${s.hint || ''})`).join('\n');

const TURN_RULES = `HOW TO INTERVIEW (this is spoken aloud, so keep it natural):
- Ask exactly ONE question per turn. Max ~25 words. No lists, no markdown, no emojis.
- Start with a very short acknowledgement that proves you listened (reference something they said), then the question.
- Prefer follow-ups that dig into the vaguest or most important gap: clarify ("what do you mean by..."), quantify ("roughly how many..."),
  ownership ("what part did you personally..."), example ("walk me through the last time..."), outcome ("what changed...").
- Don't ask more than 2 follow-ups on one slot; if they don't know, mark it "unknown" and move on.
- If an answer covers several slots, fill them all and don't re-ask.
- If the user is off-topic, rambling, or contradicts themselves, gently steer back or confirm ("Earlier you said X, now Y, which is right?").
- EXACT DETAILS (email, phone, URL, username, spelling of names): speech recognition often garbles these. After the user gives one, repeat it back cleanly
  ("So that's asharao91 at example dot com, right?") and wait for a yes before moving on. If it looks wrong or incomplete (e.g. "getup.com" for GitHub), ask them to spell it.
  When you read a value back, repeat the user's EXACT characters and words: never respell, reformat, translate or "correct" it (if they said asha-resume, say asha-resume).
  Read each value back AT MOST ONCE. If the user's next message does not object (even if it answers something else), treat it as confirmed and move on: never read the same value back again.
  Once confirmed, don't ask again. Fix obvious recognition errors yourself in the stored value (e.g. "asha rao 91@example.com" -> "asharao91@example.com").
- If one message contains several facts (e.g. phone AND where they heard about it), acknowledge all of them and record them all; don't drop any, and only then ask about the next missing field.
- Don't ask for something already implied by an earlier answer (e.g. "start immediately" already implies zero notice period). Only say "lastly"/"one last thing" when exactly one topic is left.
- If the user says they don't know / don't have it / prefer not to say, accept it: do NOT ask the same thing again. Offer once to skip it ("no problem, we can leave that blank") and move to the next topic.
- If an answer is vague ("any role", "some tools"), ask one follow-up to make it concrete before moving on.
- If they interrupt/correct you, accept it and adapt. If the transcript looks garbled, ask them to repeat.
- If they share sensitive data (names, phone, money, internal systems), record it under "sensitive" and, once, tell them you'll offer redaction at the end.
- When every slot is filled or marked unknown, set "done": true and make "reply" a brief wrap-up that says you'll prepare the summary for their review.
- When you repeat a number or amount back, say it exactly as the user said it (never convert or add up).
- Never invent facts. Only record what the user said (status "stated") or clearly implied (status "inferred").`;

function turnSystem(uc, slots) {
  return `${uc.persona}\n\nINFORMATION TO COLLECT (slots):\n${slotList(slots)}\n\n${TURN_RULES}

Respond with ONLY JSON:
{"slots": {"<slot id>": {"value": "concise summary or empty string", "status": "empty|partial|stated|inferred|unknown", "evidence": "short quote from user"}},
 "sensitive": [{"text": "the sensitive thing", "reason": "why"}],
 "reply": "what you say next, spoken aloud",
 "done": false}
Include ALL slot ids every turn (carry forward previous values, improve them with new info).`;
}

function turnUser(state, transcript) {
  const t = transcript.map(m => `${m.role === 'agent' ? 'AGENT' : 'USER'}: ${m.text}`).join('\n');
  return `CURRENT SLOT STATE:\n${JSON.stringify(state.slots || {})}\nSENSITIVE SO FAR: ${JSON.stringify(state.sensitive || [])}\n\nTRANSCRIPT:\n${t}\n\nProduce the next JSON.`;
}

const transcriptText = t => t.map(m => `${m.role === 'agent' ? 'AGENT' : 'USER'}: ${m.text}`).join('\n');
const isFilled = v => v && ['stated', 'unknown'].includes(v.status);   // 'inferred' is a guess: it still needs one confirming question

const fromProfile = v => v && v.status === 'inferred' && /from your profile/i.test(v.evidence || '');            // a stored fact: confirmed in one bulk question
const isResumeDraft = v => v && v.status === 'inferred' && /drafted from your resume/i.test(v.evidence || '');   // a longer drafted answer: reviewed at the end, not read out
function replySystem(uc, slots, state, profileSeen = false) {
  // answers pre-filled from the user's profile count as covered once the agent has already shown them for confirmation
  const gaps = slots.filter(sl => !isFilled(state.slots?.[sl.id]) && !(profileSeen && fromProfile(state.slots?.[sl.id])) && !isResumeDraft(state.slots?.[sl.id]));
  const known = slots.filter(sl => isFilled(state.slots?.[sl.id])).map(sl => sl.label).join(', ') || 'nothing yet';
  const goal = gaps.length
    ? `STILL NEEDED (most important first): ${gaps.map(g => g.label + ' (' + (g.hint || '') + ')' + (state.slots?.[g.id]?.status === 'inferred' ? ' [only GUESSED so far: ask the user one short yes/no question to confirm it]' : '')).join('; ')}.\nALREADY COVERED: ${known}.`
    : `Everything needed has been covered. Briefly thank them and say you'll prepare the summary for their review. Set "done": true.`;
  return `${uc.persona}\n\n${goal}\n\n${TURN_RULES.split('\n').filter(l => !/^- (When every slot|Never invent|If they share sensitive)/.test(l)).join('\n')}
- Read the TRANSCRIPT first. Never ask something the user already answered. Build on their last sentence.
- CHOICE FIELDS: when a field says "ONLY these choices", you may name ONLY options copied exactly from that list; never invent, rename or add options (not even obvious ones).
  If the user's answer is not in the list, say so briefly and offer the 2-3 closest options FROM THE LIST, or ask them to pick one. Never guess which one they meant.
- NEVER repeat or rephrase a question that already appears in the transcript, even if the user skipped it; if they dodged it, move on to a different topic.
Respond with ONLY JSON: {"reply": "what you say next, spoken aloud", "done": false}`;
}

function trackSystem(uc, slots) {
  return `You track an interview. ${uc.persona}\n\nSLOTS:\n${slotList(slots)}
Read the transcript and update every slot. Status: empty (nothing), partial (vague/incomplete), stated (user said it clearly), inferred (directly implied by their words, not actually said; never infer one fact from an unrelated one, e.g. willingness to relocate does NOT imply work authorization), unknown (user said they don't know).
Use ONLY what the user said. A slot whose evidence says 'drafted from your resume' is a draft the user will review at the end: keep its value and status exactly as it is unless the user talks about that question. A value whose evidence says it came 'from your profile' was pre-filled for the user to check: when they confirm it (yes / correct / that's right, or when they say all of it is fine) set its status to stated; if they correct it, store the corrected value as stated; if they do not react to it at all, leave it inferred.\nNUMBERS & MONEY: keep values exactly as the user said them, with their units. Never add, convert or merge numbers (write '1.5 years professional + 6 months internship', not '2 years'). 'k' = thousand, 'lakh' = 100,000, 'million' = 10 lakh, so 1.5 million = 15 lakh = 1,500,000. Don't mix these up. If a figure is ambiguous (e.g. CTC '500k' vs '1.5 million'), keep both as said and mark it for confirmation. Record sensitive items (names, phone numbers, money, client/system names). Set "done": true only when every slot is stated or unknown. A slot that is only inferred is NOT done: it must be confirmed with the user first.
Respond with ONLY JSON:
{"slots": {"<slot id>": {"value": "concise summary or empty string", "status": "empty|partial|stated|inferred|unknown", "evidence": "short quote"}}, "sensitive": [{"text": "...", "reason": "..."}], "done": false}
Include ALL slot ids.`;
}

function briefSystem(uc, slots) {
  const aud = uc.audiences.map(a => `"${a.id}": ${a.instruction}`).join('\n');
  return `You turn an interview transcript into a structured, decision-ready document. ${uc.persona}
Fields:\n${slotList(slots)}
Rules: use ONLY what the user said.\nNUMBERS & MONEY: keep values exactly as the user said them, with their units. Never add, convert or merge numbers (write '1.5 years professional + 6 months internship', not '2 years'). 'k' = thousand, 'lakh' = 100,000, 'million' = 10 lakh, so 1.5 million = 15 lakh = 1,500,000. Don't mix these up. If a figure is ambiguous (e.g. CTC '500k' vs '1.5 million'), keep both as said and mark it for confirmation. Write in first person or neutral wording ("the applicant", "they"); never guess gender or use he/she/his/her. Label every field's "kind": "fact" (stated by user), "assumption" (inferred, needs confirmation) or "unknown".
List important missing information and sensitive items. Never fabricate numbers.
Write each audience version in markdown:\n${aud}
Respond with ONLY JSON:
{"title": "...", "summary": "2-3 sentences",
 "fields": [{"id": "slot id", "label": "...", "value": "...", "kind": "fact|assumption|unknown", "evidence": "quote"}],
 "missing": ["what is still unknown and worth asking"],
 "sensitive": [{"text": "...", "reason": "...", "suggested_replacement": "..."}],
 "versions": {"<audience id>": "markdown text"}}`;
}

// ---- API handlers -------------------------------------------------------------
const api = {
  'GET /api/config': async () => ({
    hasKey: HAS[ROLES.turn.provider] && HAS[ROLES.brief.provider], provider: PROVIDER, split: SPLIT, roles: ROLES, sarvamVoice: !!SARVAM, storage: store.CONFIGURED ? 'supabase' : 'NOT CONFIGURED',
    usecases: usecases.list.map(u => ({ id: u.id, name: u.name, dynamicSlots: u.dynamicSlots, opening: u.opening, slots: u.slots }))
  }),

  // Read a public link: the form's real questions (never guessed) + job description text.
  'POST /api/read-form': async ({ url }) => readForm(String(url || '').trim()),

  // Form mode: a link (read for real) or pasted form text (LLM-extracted) becomes interview slots.
  'POST /api/setup': async ({ text }) => {
    text = String(text || '').trim();
    if (/^https?:\/\//i.test(text)) {
      const form = await readForm(text.split(/\s+/)[0]);
      if (!form.ok) throw new Error(`${form.reason} ${form.hint || ''}`.trim());
      const slots = form.fields.filter(f => !f.prefilled).map(f => ({
        id: f.field_id, label: f.label,
        hint: [f.type, f.required ? 'required' : 'optional', f.options ? `ONLY these choices: ${f.options.join(' | ')}` : '', f.fill_capability === 'unsupported' ? f.unsupported_reason : ''].filter(Boolean).join('; ')
      }));
      return { slots, form: { source: form.source, title: form.title, url: form.url, captcha: form.captcha, warnings: form.warnings, jd: form.jd } };
    }
    const out = await llm({
      role: 'turn', maxTokens: 1500,
      system: `Extract the questions/fields from this form or application. For each, write what information a good answer needs.
Respond ONLY JSON: {"slots":[{"id":"q1","label":"short field name","hint":"what a strong answer must contain"}]}. Max 12 slots.`,
      user: text
    });
    return out;
  },

  'POST /api/turn': async ({ usecase, slots, state, transcript }) => {
    const uc = usecases.get(usecase);
    const s = slots?.length ? slots : uc.slots;
    // Small/fast models sometimes return malformed JSON or omit "reply"; retry once, then fall back so the call never dies.
    const run = () => llm({ role: 'turn', system: turnSystem(uc, s), user: turnUser(state, transcript), maxTokens: 1500 }).catch(() => null);
    let out = await run();
    if (!out || typeof out.reply !== 'string' || !out.reply.trim()) out = await run();
    if (!out || typeof out.reply !== 'string' || !out.reply.trim()) {
      return { slots: state.slots || {}, sensitive: state.sensitive || [], reply: 'Sorry, could you say that once more?', done: false };
    }
    return out;
  },

  // Split mode, fast path: only the next spoken line.
  'POST /api/reply': async ({ usecase, slots, state, transcript }) => {
    const uc = usecases.get(usecase);
    const sl = slots?.length ? slots : uc.slots;
    // Some models (e.g. sarvam-105b-conversations) ignore "JSON only" and just speak the reply: accept both.
    const run = async (role = 'turn') => {
      try {
        const t = await llm({ role, raw: true, system: replySystem(uc, sl, state || {}, transcript.some(m => m.role === 'agent' && /pre-?filled|from your profile|from your resume/i.test(m.text))), user: `TRANSCRIPT:\n${transcriptText(transcript)}\n\nProduce the next JSON.`, maxTokens: 300 });
        try { return parseJSON(t); } catch { return { reply: t.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^["']|["']$/g, ''), done: false }; }
      } catch (e) { console.error('reply error:', e.message.slice(0, 300)); return null; }
    };
    let out = await run('turn');
    if (!out || typeof out.reply !== 'string' || !out.reply.trim()) out = await run('turnFallback');
    if (!out || typeof out.reply !== 'string' || !out.reply.trim()) return { reply: 'Sorry, could you say that once more?', done: false };
    // Small models ramble and double-barrel; for voice keep everything up to the FIRST question.
    let reply = out.reply.trim();
    const q = reply.indexOf('?');
    if (q > -1 && reply.slice(q + 1).trim().length > 0) reply = reply.slice(0, q + 1);
    return { reply, done: !!out.done };
  },

  // Split mode, background path: update slots/sensitive. The client does not block on this.
  'POST /api/track': async ({ usecase, slots, state, transcript }) => {
    const uc = usecases.get(usecase);
    const sl = slots?.length ? slots : uc.slots;
    const out = await llm({ role: 'track', system: trackSystem(uc, sl),
      user: `PREVIOUS STATE:\n${JSON.stringify(state?.slots || {})}\n\nTRANSCRIPT:\n${transcriptText(transcript)}\n\nProduce the JSON.`, maxTokens: 1500 });
    const slotsOut = out.slots || state?.slots || {};
    // "done" is computed here, not trusted from the model (some models forget to set it): every question answered or marked unknown
    const done = sl.length > 0 && sl.every(x => ['stated', 'unknown'].includes(slotsOut[x.id]?.status) || isResumeDraft(slotsOut[x.id]));
    return { slots: slotsOut, sensitive: out.sensitive || state?.sensitive || [], done };
  },

  // ---- saved sessions: start, save as you go, resume by link, history, approval ----
  'POST /api/session/start': async ({ usecase, slots, form, transcript, state }) => {
    const sess = await store.createSession({ usecase: usecase || 'form-interviewer', slots: slots || [], form_meta: form || {}, form_url: form?.url || null,
      role_title: form?.title || null, transcript: transcript || [], slot_state: state || {}, state: 'collecting' });
    return { token: sess.resume_token, storage: store.CONFIGURED ? 'supabase' : 'NOT CONFIGURED' };
  },
  'POST /api/session/save': async ({ token, transcript, state, cursor_field, sess_state }) => {
    const bad = m => Object.assign(new Error(m), { status: 400 });
    if (!Array.isArray(transcript) || !transcript.every(m => m && typeof m.text === 'string' && ['agent', 'user'].includes(m.role))) throw bad('transcript must be a list of {role, text}');
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw bad('state must be an object');
    const sess = await store.getSession(token); if (!sess) throw new Error('Session not found');
    const patch = { slot_state: state, cursor_field: typeof cursor_field === 'string' ? cursor_field.slice(0, 80) : null };
    if (transcript.length >= (sess.transcript || []).length) patch.transcript = transcript;   // a stale save (older tab) must never shorten the conversation
    // approved/cancelled are final: a late save cannot silently reopen them
    if (!['approved', 'cancelled'].includes(sess.state) && ['collecting', 'reviewing'].includes(sess_state)) patch.state = sess_state;
    await store.updateSession(token, patch);
    return { ok: true };
  },
  'GET /api/session': async (_, url) => {
    const sess = await store.getSession(url.searchParams.get('token'));
    if (!sess) throw new Error('That link does not match a saved session.');
    return { token: sess.resume_token, usecase: sess.usecase, state: sess.state, slots: sess.slots, form: sess.form_meta, transcript: sess.transcript,
      slot_state: sess.slot_state, cursor_field: sess.cursor_field, outcome: sess.outcome, updated_at: sess.updated_at };
  },
  'GET /api/sessions': async () => ({ sessions: await store.listSessions(), storage: store.CONFIGURED ? 'supabase' : 'NOT CONFIGURED' }),
  'POST /api/session/outcome': async ({ token, outcome, note, company }) => {
    if (!['none', 'applied', 'responded', 'interview', 'rejected', 'offer'].includes(outcome)) throw new Error('Unknown outcome');
    if (!(await store.updateSession(token, { outcome, outcome_note: note ?? undefined, company: company ?? undefined }))) throw new Error('Session not found');
    return { ok: true };
  },
  // A correction in the review screen: new revision, old one stays.
  'POST /api/session/draft': async ({ token, field_id, answer, review_status, evidence_source, missing_info }) => {
    const sess = await store.getSession(token); if (!sess) throw new Error('Session not found');
    return { revision: (await store.addDraftRevision(sess.id, field_id, answer, review_status || 'revised', evidence_source, missing_info)).revision };
  },
  // Approve / revise / cancel: approval stores an immutable snapshot of exactly what was shown. Nothing is submitted anywhere.
  'POST /api/session/decide': async ({ token, decision, snapshot }) => {
    if (!['approved', 'revise', 'cancelled'].includes(decision)) throw new Error('Unknown decision');
    const sess = await store.getSession(token); if (!sess) throw new Error('Session not found');
    if (sess.state === decision || (sess.state === 'approved' && decision !== 'approved') || (sess.state === 'cancelled' && decision !== 'cancelled')) {
      // already decided: repeating the same decision is a no-op; a final state is never reversed
      if (sess.state === decision || sess.state === 'approved' || sess.state === 'cancelled') return { ok: true, already: sess.state, submitted: false };
    }
    const approval = await store.addApproval(sess.id, decision, snapshot || {});
    await store.updateSession(token, { state: { approved: 'approved', revise: 'reviewing', cancelled: 'cancelled' }[decision], ...(decision === 'approved' && { outcome: sess.outcome === 'none' ? 'none' : sess.outcome }) });
    return { ok: true, approval_id: approval.id, submitted: false };
  },

  'POST /api/brief': async ({ usecase, slots, state, transcript }) => {
    const uc = usecases.get(usecase);
    const s = slots?.length ? slots : uc.slots;
    const req = { maxTokens: 4000, system: briefSystem(uc, s), user: `SLOT STATE:\n${JSON.stringify(state.slots || {})}\n\nFULL TRANSCRIPT:\n${transcriptText(transcript)}` };
    let lastErr;
    for (const r of ROLES.briefChain) {
      try { const out = await llm({ role: r, ...req }); if (out && Array.isArray(out.fields)) return out; throw new Error('brief missing fields'); }
      catch (e) { lastErr = e; console.error(`brief via ${ROLES[r].provider}/${ROLES[r].model} failed: ${e.message.slice(0, 160)}`); }
    }
    throw lastErr;
  }
};

// ---- extensions: every lib/ext/*.js exports (ctx) => ({ 'GET /api/x': async (body, url) => result, ... }) ----
try {
  const dir = path.join(__dirname, 'lib', 'ext');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    try { Object.assign(api, require(path.join(dir, f))({ store, llm, parseJSON, usecases, transcriptText, readForm })); console.log('extension loaded:', f); }
    catch (e) { console.error(`extension ${f} failed to load:`, e.message); }
  }
} catch (e) { if (e.code !== 'ENOENT') console.error('extensions:', e.message); }

// ---- voice (Sarvam): speech-to-text and text-to-speech -------------------------------
const readBody = async req => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
const sendJSON = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));

async function voiceSTT(req, res) {   // body = raw audio bytes (webm/ogg/wav/mp3...), content-type = audio mime
  try {
    if (!SARVAM) throw new Error('Set SARVAM_KEY in .env');
    const audio = await readBody(req);
    if (audio.length < 1000) return sendJSON(res, 200, { transcript: '' });
    const fd = new FormData();
    fd.append('model', process.env.SARVAM_STT_MODEL || 'saaras:v4');
    fd.append('mode', process.env.SARVAM_STT_MODE || 'transcribe');
    fd.append('file', new Blob([audio], { type: (req.headers['content-type'] || 'audio/webm').split(';')[0] }), 'speech.webm');
    const r = await fetch('https://api.sarvam.ai/speech-to-text', { method: 'POST', headers: { 'api-subscription-key': SARVAM }, body: fd, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `Sarvam STT ${r.status}`);
    sendJSON(res, 200, { transcript: (j.transcript || '').trim(), language: j.language_code });
  } catch (e) { console.error('STT error:', e.message); sendJSON(res, 500, { error: e.message }); }
}

async function voiceTTS(req, res) {   // body = {text, lang?}; responds with audio/wav
  try {
    if (!SARVAM) throw new Error('Set SARVAM_KEY in .env');
    const { text, lang } = JSON.parse((await readBody(req)).toString() || '{}');
    if (!text) throw new Error('No text');
    const r = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST', headers: { 'api-subscription-key': SARVAM, 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ text: text.slice(0, 1500), language_code: lang || process.env.SARVAM_TTS_LANG || 'en-IN',
        model: process.env.SARVAM_TTS_MODEL || 'bulbul:v4-flash', speaker: process.env.SARVAM_SPEAKER || 'simran_en_customer',
        pace: +process.env.SARVAM_PACE || 1.05, enable_preprocessing: true })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `Sarvam TTS ${r.status}`);
    res.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.from(j.audios[0], 'base64'));
  } catch (e) { console.error('TTS error:', e.message); sendJSON(res, 500, { error: e.message }); }
}

// ---- server ---------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/stt') return voiceSTT(req, res);
  if (req.method === 'POST' && url.pathname === '/api/tts') return voiceTTS(req, res);
  const handler = api[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 1_000_000) return res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Request too large' })); }
      let parsed; try { parsed = body ? JSON.parse(body) : {}; } catch { return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON' })); }
      if (parsed === null || typeof parsed !== 'object') parsed = {};
      const out = await handler(parsed, url);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      console.error('API error:', e.message);
      const bad = e instanceof TypeError || e.status === 400;   // wrong-shaped input: a short 400, not an internal-error dump
      res.writeHead(bad ? 400 : 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: bad && e instanceof TypeError ? 'Invalid request' : e.message }));
    }
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(__dirname, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(__dirname, 'public'))) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
}).listen(PORT, process.env.HOST || '127.0.0.1', () => {   // localhost only unless HOST is set: other people on the Wi-Fi cannot reach it
  console.log(`Voice Interviewer Kit on http://localhost:${PORT}  (turn: ${ROLES.turn.provider}/${ROLES.turn.model}, track: ${ROLES.track.provider}/${ROLES.track.model}, brief: ${ROLES.brief.provider}/${ROLES.brief.model}, split: ${SPLIT})`);
  console.log('Use Chrome or Edge for speech recognition.');
});
