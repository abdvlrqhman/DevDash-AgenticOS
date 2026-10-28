-- Each member's profile picture, shown wherever DevDash shows who someone is. The browser crops and shrinks it to a
-- small square before uploading; the server checks it really is a JPEG, PNG or WebP. In the database, so backups keep it.
create table user_avatars (
  user_id integer primary key references users(id) on delete cascade,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data blob not null,
  updated_at integer not null default (unixepoch())
);
