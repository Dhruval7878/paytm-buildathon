# Plan: Personal Interviewer (job application filling)

**One-liner:** We are helping a job applicant turn a public application link into reviewed, grounded draft answers, without filling forms by hand.
**Done means:** link read -> interview -> draft answers grounded in what the person said (gaps shown, never invented) -> person corrects at least one -> sees an exact preview -> approve / revise / cancel. Nothing is submitted by the system.
**Out of scope:** auto-submitting, accounts/login, real personal data in tests.

## Loop
1. **Start:** paste a public job/application link -> read the real questions (embedded data -> HTML form -> Browserless -> "paste the questions").
2. **Collect:** short follow-ups, one at a time, including exact choices from the form. Read back emails/phones/URLs.
3. **Draft:** answers grounded in facts the person gave; gaps listed.
4. **Review:** confirm / change / skip each answer; corrections create a new revision, old one stays.
5. **Approve:** exact preview, then approve / revise / cancel. Filling and submitting are separate later actions.

## Saved state (Supabase) and resume by link
- Session created at start with a private random token; link shown early: `/?s=<token>`.
- Every turn saves transcript, facts, drafts, and the current question; reopening the link restores it and continues.
- Tables: see `db/schema.sql` (add a `transcript` column to `sessions`). Keys only on the server.
- n8n: one visible job (e.g. email the resume link, or notify on approval).

## Stretch (same fact bank, different output)
- Tailored resume points vs the job description: grounded only in stated facts, gaps shown, honest keyword coverage (no invented ATS score).
- Mock interview: the agent interviews the person using the JD, then gives feedback.

## Tests (from the workbook)
Working link | broken/private link (stops safely) | email/phone/url/long-answer/choice fields | change an answer (old version kept) | pause and return to the same question | say "confirm" twice | disconnect and return | final preview == saved answers | cancel (nothing happens)

## Demo (3-5 min)
Frame user + problem; paste a link; short interview with one follow-up and one typed/choice field; correct one answer; show the approve / revise / cancel boundary and say what was NOT done. Use fictional data only.
