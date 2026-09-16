# MongoDB Atlas security for PureV2

Do not modify Atlas from automated packaging. Configure these controls in the Atlas UI before public use.

## Dedicated database user

- Create a user used only by PureV2.
- Grant only the permissions required for the application database (read/write on the PureV2 database).
- Do not reuse a shared admin user across projects.

## Separate production database

- Use a distinct database name (and ideally cluster) for production vs development.
- Never point a development bot at the production database.

## Network access

- Restrict Atlas IP access to the VPS public IP where practical.
- Avoid `0.0.0.0/0` once the VPS IP is stable.
- Remember that changing VPS IPs requires updating the Atlas allowlist.

## TLS

- Use an Atlas connection string with TLS (`mongodb+srv://...`).
- Do not disable TLS for convenience.

## Secrets handling

- Never commit `MONGODB_URI` or bake it into image layers.
- Store it only in the server-side `.env` with mode `600`.
- If the URI or password is exposed, rotate the database user password immediately and update `.env`.

## Backups

- Enable Atlas backups/snapshots before public or long-running use.
- Take a fresh backup before destructive index or data maintenance.
- Index maintenance in PureV2 verifies and creates missing indexes only; it does not drop indexes by default.
