-- Give an unfinished idle session one more decision if its first wake only reported progress.
alter table assistant_follows add column retried_activity integer;
