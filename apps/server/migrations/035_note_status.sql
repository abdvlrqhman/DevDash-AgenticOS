-- Notes go stale: a weekly summary or a product list keeps looking current long after it isn't. Give a note a status
-- (draft / confirmed / superseded) and a "superseded by" link to the note that replaced it. Existing notes are current,
-- so they default to confirmed. When a role writes a new weekly summary, its previous one is marked superseded (service).
alter table notes add column status text not null default 'confirmed' check (status in ('draft', 'confirmed', 'superseded'));
alter table notes add column superseded_by integer references notes(id) on delete set null;
