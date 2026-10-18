// Read a public job/application link and return the form's REAL questions (never guessed).
// Strategy chain, cheapest first: embedded form JSON -> plain HTML form -> Browserless (rendered) -> give up safely.
const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 3_000_000;

// ---- safety: public http(s) URLs only (blocks localhost / private networks / cloud metadata) ----
function isPrivateIP(ip) {
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    // IPv4 hidden inside IPv6 (::ffff:7f00:1 or ::ffff:127.0.0.1, NAT64 64:ff9b::/96): decode the 4 bytes and check them as IPv4
    const mapped = x.match(/^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (mapped) {
      if (mapped[1]) return isPrivateIP(mapped[1]);
      const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16);
      return isPrivateIP(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    // other transition ranges can embed arbitrary IPv4 addresses: refuse them outright
    if (x.startsWith('::ffff:') || x.startsWith('64:ff9b:') || x.startsWith('2002:') || x.startsWith('2001:0:') || x.startsWith('2001::')) return true;
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('fec0') || x.startsWith('ff');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That does not look like a valid link.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links are supported.');
  if (u.username || u.password) throw new Error('Links with embedded credentials are not allowed.');
  if (raw.length > 2000) throw new Error('Link is too long.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error('Could not resolve that website.'); });
  if (!addrs.length || addrs.some(a => isPrivateIP(a.address))) throw new Error('That address is private or internal, so it cannot be read.');
  return u;
}

// ---- fetching (manual redirects so every hop is re-checked) ----
async function fetchPublic(raw, { timeoutMs = 15000 } = {}) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(url);
    // network hiccups (venue Wi-Fi) are common: retry once and report the real cause instead of a bare "fetch failed"
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; VoiceInterviewerKit/1.0)', accept: 'text/html,application/xhtml+xml' } });
        break;
      } catch (e) {
        const why = e.cause?.code || e.cause?.message || e.name;
        console.error(`read-form fetch attempt ${attempt} failed (${why}): ${u.hostname}`);
        if (attempt >= 2) throw new Error(`Could not reach that website (${why}). Check your connection and try again.`);
        await new Promise(r => setTimeout(r, 800));
      }
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), u).href; continue; }
    if (!res.ok) throw new Error(`The page returned HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (private or login-protected?)' : ''}.`);
    const ctype = res.headers.get('content-type') || '';
    if (ctype && !/html|xml|text\/plain/i.test(ctype)) throw new Error(`That link is not a web page (${ctype.split(';')[0]}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Page is too large to read.');
    return { html: buf.toString('utf8'), finalUrl: u.href };
  }
  throw new Error('Too many redirects.');
}

async function renderWithBrowserless(raw) {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('Browserless is not configured (set BROWSERLESS_TOKEN in .env).');
  await assertPublicUrl(raw);
  const base = process.env.BROWSERLESS_URL || 'https://production-sfo.browserless.io';
  const res = await fetch(`${base}/content?token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(45000),
    body: JSON.stringify({ url: raw, gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 } })
  });
  if (!res.ok) throw new Error(`Browserless error ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.text();
}

// ---- helpers ----
const decode = s => String(s ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const stripTags = s => decode(String(s).replace(/<[^>]*>/g, ' '));
const TYPE_MAP = { Data: 'text', 'Small Text': 'longtext', Text: 'longtext', 'Long Text': 'longtext', 'Text Editor': 'longtext', Select: 'choice', Autocomplete: 'choice',
  Link: 'choice', Int: 'number', Float: 'number', Currency: 'currency', Date: 'date', Check: 'checkbox', Attach: 'file', 'Attach Image': 'file', Phone: 'phone' };

// ---- strategy 1: embedded Frappe-style web form JSON ----
function fromEmbeddedWebForm(html, params) {
  const i = html.indexOf('web_form_fields');
  if (i < 0) return null;
  const s = html.indexOf('[', i); if (s < 0) return null;
  let depth = 0, j = s, inStr = false, esc = false;
  for (; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '[') depth++; else if (c === ']' && --depth === 0) break;
  }
  let arr; try { arr = JSON.parse(html.slice(s, j + 1)); } catch { try { arr = JSON.parse(html.slice(s, j + 1).replace(/\\"/g, '"')); } catch { return null; } }
  if (!Array.isArray(arr)) return null;
  let captcha = false, position = 0; const fields = [];
  for (const f of arr) {
    if (/captcha/i.test(f.fieldname || '')) { captcha = true; continue; }
    if (['HTML', 'Section Break', 'Column Break', 'Button', 'Heading'].includes(f.fieldtype) || f.hidden) continue;
    const options = (f.options || '').toString().split('\n').map(x => x.trim()).filter(Boolean);
    const type = TYPE_MAP[f.fieldtype] || 'text';
    const hasOpts = type === 'choice' && options.length;
    fields.push({ field_id: f.fieldname, position: position++, label: decode(f.label || f.fieldname), type: /email/i.test(f.fieldname) ? 'email' : /mobile|phone/i.test(f.fieldname) ? 'phone' : /link|url/i.test(f.fieldname) ? 'url' : type,
      required: !!f.reqd, options: hasOpts ? options : null, step: 1, locator: `[data-fieldname="${f.fieldname}"]`,
      prefilled: params[f.fieldname] ?? null,
      fill_capability: type === 'file' ? 'unsupported' : 'supported', unsupported_reason: type === 'file' ? 'File upload cannot be filled automatically' : null });
  }
  return fields.length ? { fields, captcha, source: 'embedded form data' } : null;
}

// ---- strategy 2: ordinary HTML <form> (labels, inputs, textareas, selects) ----
function fromHtmlForm(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '');
  const labels = {}; for (const m of body.matchAll(/<label[^>]*\sfor=["']([^"']+)["'][^>]*>([\s\S]*?)<\/label>/gi)) labels[m[1]] = stripTags(m[2]);
  const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1];
  const fields = []; let position = 0, captcha = /g-recaptcha|h-captcha|cf-turnstile|captcha/i.test(body);
  const tagRe = /<(input|textarea|select)\b[^>]*>(?:[\s\S]*?<\/\1>)?/gi;
  for (const m of body.matchAll(tagRe)) {
    const tag = m[0], kind = m[1].toLowerCase(), t = (attr(tag, 'type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(t) || /captcha/i.test(attr(tag, 'name') || attr(tag, 'id') || '')) continue;
    const id = attr(tag, 'id'), name = attr(tag, 'name') || id; if (!name) continue;
    const label = labels[id] || attr(tag, 'aria-label') || attr(tag, 'placeholder') || name;
    let type = kind === 'textarea' ? 'longtext' : kind === 'select' ? 'choice' : t === 'email' ? 'email' : t === 'tel' ? 'phone' : t === 'url' ? 'url' : t === 'number' ? 'number' : t === 'file' ? 'file' : t === 'checkbox' || t === 'radio' ? 'choice' : t === 'date' ? 'date' : 'text';
    const options = kind === 'select' ? [...tag.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/gi)].map(o => stripTags(o[1])).filter(x => x && !/^(select|choose|--)/i.test(x)) : null;
    if ((t === 'radio' || t === 'checkbox') && fields.find(f => f.field_id === name)) { const f = fields.find(x => x.field_id === name); (f.options ||= []).push(attr(tag, 'value') || label); continue; }
    fields.push({ field_id: name, position: position++, label: decode(label), type, required: /\srequired\b/i.test(tag) || attr(tag, 'aria-required') === 'true',
      options: options?.length ? options : (t === 'radio' || t === 'checkbox' ? [attr(tag, 'value') || label] : null), step: 1, locator: id ? `#${id}` : `[name="${name}"]`, prefilled: null,
      fill_capability: type === 'file' ? 'unsupported' : 'supported', unsupported_reason: type === 'file' ? 'File upload cannot be filled automatically' : null });
  }
  return fields.length ? { fields, captcha, source: 'page HTML form' } : null;
}

// ---- job description text (for tailoring answers/resume later) ----
function extractJD(html) {
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => { try { return JSON.parse(m[1]); } catch { return null; } }).flat().filter(Boolean)
    .find(o => o['@type'] === 'JobPosting');
  const title = decode(ld?.title || (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const meta = decode((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '');
  const body = stripTags(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' '));
  return { title, description: ld?.description ? stripTags(ld.description).slice(0, 6000) : '', meta, page_text: body.slice(0, 4000) };
}

// ---- main ----
async function readForm(raw) {
  const warnings = []; let params = {};
  let url; try { url = await assertPublicUrl(raw); params = Object.fromEntries(url.searchParams); } catch (e) { return { ok: false, reason: e.message, hint: 'Check the link, or paste the questions instead.' }; }
  let html, finalUrl = raw;
  try { ({ html, finalUrl } = await fetchPublic(raw)); }
  catch (e) { return { ok: false, reason: e.message, hint: 'The link may be broken or private. Paste the questions instead.' }; }

  let found = fromEmbeddedWebForm(html, params) || fromHtmlForm(html), jd = extractJD(html);
  if (!found) {
    try { const rendered = await renderWithBrowserless(raw); found = fromEmbeddedWebForm(rendered, params) || fromHtmlForm(rendered); if (found) { found.source += ' (rendered by Browserless)'; jd = extractJD(rendered); } }
    catch (e) { warnings.push(e.message); }
  }
  if (!found) return { ok: false, reason: 'No form questions were found on that page.', warnings, jd: { title: jd.title }, hint: 'It may be a multi-step or login-protected form. Paste the questions instead.' };
  if (found.captcha) warnings.push('This form has a captcha, so it cannot be submitted automatically. The agent can draft answers and a preview; the person submits.');
  return { ok: true, source: found.source, url: finalUrl, title: jd.title, fields: found.fields, captcha: found.captcha, jd, warnings };
}

module.exports = { readForm, assertPublicUrl };
