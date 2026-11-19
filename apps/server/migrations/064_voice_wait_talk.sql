-- Whether Hamasa says something while a slow answer is on its way ("let me check", "still on it"). Off: it speaks only
-- when it has something to say.
alter table voice_settings add column wait_talk integer not null default 0;
