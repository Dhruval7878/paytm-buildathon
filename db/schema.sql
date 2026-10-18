-- Personal Interviewer: saved state. Paste into Supabase > SQL Editor > Run.
-- Design rules (from the workbook): backend state is the truth; answers are append-only
-- (a correction = new row, old one stays); approval binds to one immutable set of drafts.
-- Use fictional test data only.

create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  state        text not null default 'awaiting_link'
               check (state in ('awaiting_link','extracting','collecting','drafting','reviewing','paused','previewing','approved','cancelled')),
  form_url     text,
  cursor_field text,                       -- field the user is currently on (resume point after pause/disconnect)
  transcript   jsonb not null default '[]'::jsonb,   -- full conversation, so the agent knows what was already said on resume
  slot_state   jsonb not null default '{}'::jsonb,   -- live "what the agent knows" panel
  company      text,                       -- for the history list
  role_title   text,
  outcome      text not null default 'none'
               check (outcome in ('none','applied','responded','interview','rejected','offer')),   -- you update this by hand
  outcome_note text,
  resume_token text unique not null default replace(gen_random_uuid()::text, '-', ''),   -- private link key (32 hex chars)
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- Field contract: what the real form asks (read by Browserless, never guessed by the agent)
create table if not exists form_fields (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid references sessions(id) on delete cascade,
  field_id           text not null,        -- stable id from the page
  position           int  not null,        -- order on the form
  label              text not null,
  type               text not null,        -- text | email | phone | url | longtext | choice | checkbox | file ...
  required           boolean default false,
  options            jsonb,                -- for choices
  step               int default 1,
  locator            text,                 -- stable selector for a later fill
  fill_capability    text default 'supported',   -- supported | unsupported
  unsupported_reason text,
  unique (session_id, field_id)
);

-- What we know about the person (with where it came from: never invent)
create table if not exists facts (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  key        text not null,                -- e.g. full_name, email, years_experience, project_1
  value      text not null,                -- kept exactly as said (no unit conversion)
  evidence   text,                         -- quote or source
  status     text default 'stated' check (status in ('stated','inferred','confirmed')),
  created_at timestamptz default now()
);

-- Draft contract: append-only. Editing an answer inserts revision+1 and leaves the old row.
create table if not exists drafts (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid references sessions(id) on delete cascade,
  field_id        text not null,
  revision        int  not null default 1,
  answer          text,
  evidence_source text,                    -- which fact(s) this answer is grounded in
  missing_info    text,                    -- what we still need to ask (shown, not invented)
  review_status   text not null default 'draft' check (review_status in ('draft','confirmed','revised','skipped')),
  created_at      timestamptz default now(),
  unique (session_id, field_id, revision)
);

-- Your stored profile (single user, local). Pre-fills answers later; every value still gets confirmed.
create table if not exists profile_facts (
  key          text primary key,           -- full_name, email, phone, github, years_experience ...
  value        text not null,              -- kept as written
  source       text default 'resume',      -- where it came from
  confirmed_at timestamptz,                -- when you last confirmed it
  updated_at   timestamptz default now()
);

-- Approval binds to the exact revisions shown in the preview. Filling/submitting are separate, later actions.
create table if not exists approvals (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid references sessions(id) on delete cascade,
  decision      text not null check (decision in ('approved','revise','cancelled')),
  snapshot      jsonb not null,            -- immutable copy of every field + answer + revision at approval time
  submitted     boolean not null default false,   -- nothing is "submitted" until the destination confirms it
  created_at    timestamptz default now()
);

create index if not exists drafts_latest on drafts (session_id, field_id, revision desc);

-- Lock it down: only the server's service key (bypasses RLS) can touch these tables.
alter table sessions    enable row level security;
alter table form_fields enable row level security;
alter table facts       enable row level security;
alter table drafts      enable row level security;
alter table approvals   enable row level security;
alter table profile_facts enable row level security;
