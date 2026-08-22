# Bun data operations

The Bun deployment keeps its SQLite database at
`$GMPAY_DATA_DIR/gmpay.sqlite` and private objects under
`$GMPAY_DATA_DIR/objects`. The maintained CLI and application server both use
Bun and its native SQLite driver.

## Backup and restore

Stop the GMPay Edge container before backup or restore so the database and
object files remain at the same logical point in time.

```bash
GMPAY_DATA_DIR=/srv/gmpay bun run data -- backup --output /srv/backups/gmpay-2026-08-20
GMPAY_DATA_DIR=/srv/gmpay-restored bun run data -- restore --input /srv/backups/gmpay-2026-08-20
```

The published image contains the same CLI. For example, after stopping the
service, mount an external backup directory and run:

```bash
docker compose stop gmpay-edge
docker compose run --rm --no-deps \
  --volume "$PWD/backups:/backups" \
  gmpay-edge bun run data -- backup --output /backups/gmpay-2026-08-20
```

The output/input path is always explicit. Backup output must be outside the
data directory. Restore accepts only a new or empty target and never overwrites
a non-empty directory. The manifest verifies every file; restore also runs
SQLite integrity, foreign-key, and migration-checksum checks.

Backups contain credentials, user data, payment records, and private uploads.
Encrypt them at rest, restrict access, and test restoration regularly.

## Import a Cloudflare export

Export D1 as SQL and export R2 objects into a local directory whose relative
paths are the original object keys. Then import into a new or empty Bun data
directory:

```bash
wrangler d1 export DB --remote --output ./d1-export.sql
GMPAY_DATA_DIR=/srv/gmpay bun run data -- import-cloudflare \
  --d1-sql ./d1-export.sql \
  --r2-dir ./r2-export \
  --r2-manifest ./r2-metadata.json
```

`--r2-dir` is optional when the instance has no objects. `--r2-manifest` is also
optional, but requires `--r2-dir`; use it to retain R2 HTTP and custom metadata.
It is a JSON object keyed by the original R2 object key:

```json
{
  "evidence/receipt.txt": {
    "httpMetadata": {
      "contentType": "text/plain; charset=utf-8",
      "cacheExpiry": "2026-09-01T00:00:00.000Z"
    },
    "customMetadata": { "orderId": "order-123" }
  }
}
```

Supported HTTP fields are `contentType`, `contentLanguage`,
`contentDisposition`, `contentEncoding`, `cacheControl`, and an ISO 8601
`cacheExpiry`. Unknown fields, non-string custom metadata, and manifest keys
without a matching exported object are rejected. Without this sidecar, object
bytes and keys are imported but R2 metadata cannot be reconstructed.

The import verifies that all repository migrations exist in the D1 export,
records their checksums for the local migration runner, validates foreign keys,
and converts R2 key paths into the hashed private-object layout. It refuses a
non-empty target, so a failed or repeated import cannot overwrite an existing
instance.
