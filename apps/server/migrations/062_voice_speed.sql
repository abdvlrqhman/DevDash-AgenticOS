-- How fast Hamasa talks in voice mode (1 is the provider's normal pace). Slightly quicker by default: at 1 its
-- Egyptian Arabic sounded slow in the first test.
alter table voice_settings add column speed real not null default 1.1;
