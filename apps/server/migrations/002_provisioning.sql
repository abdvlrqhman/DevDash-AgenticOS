-- Linux account status per member (deploy/helper user-ensure). NULL provisioned_at = not done yet.
alter table users add column provisioned_at integer;
alter table users add column provision_error text;
