-- The contact email shown on the public /about and /privacy pages, which Google checks before publishing the space's
-- Google app. Set by an admin with the app; null until then.
alter table storage_apps add column contact_email text;
