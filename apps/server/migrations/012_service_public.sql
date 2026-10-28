-- A service whose preview URL opens for anyone with the link (no DevDash sign-in), e.g. for testers.
alter table services add column public integer not null default 0;
