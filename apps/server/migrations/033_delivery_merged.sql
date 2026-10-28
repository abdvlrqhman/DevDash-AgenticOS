-- "Ready to review": remember when a delivery's branch reaches the default branch outside DevDash (a Claude session
-- merged it with --no-ff, or a fast-forward, and deployed). Every repo fetch checks each live card with
-- `git merge-base --is-ancestor`; a merged one records the merge commit and time and leaves "Ready to review".
alter table code_deliveries add column merged_commit text;
alter table code_deliveries add column merged_at integer;
