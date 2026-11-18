-- How long voice mode waits after they stop talking before their words become a message: quick, normal or patient.
alter table voice_settings add column end_wait text not null default 'normal';
