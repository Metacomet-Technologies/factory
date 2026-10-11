# Meter

Meter transparently proxies Ollama and records request metadata in SQLite.
See the [workspace README](../README.md) for configuration and deployment.

## Client identity

Client identity comes from the socket IP, never forwarded headers. IPv4 and
IPv6 loopback clients retain their IP in `client_ip`, but `client_hostname`
is the local machine's hostname, read through `gethostname` and cached at
startup. Other clients use the refreshed Tailscale hostname cache, falling
back to their IP string when unknown. Existing database rows are not rewritten.

## Incremental request sync

`GET /meter/requests` always returns a JSON array of request records.

- Without `after_id`, behavior is unchanged: newest ID first, default limit
  100, allowed limits 1–10000. There is no cursor header.
- With a nonnegative `after_id`, return records with `id > after_id`, ordered
  by ascending ID. The default limit is 500; allowed limits are 1–5000.
  Invalid cursors or limits return HTTP 400.
- Cursor responses include the `next_after_id` header. It contains the last
  returned ID, or the supplied cursor if the page is empty.

Start with `after_id=0`, persist the response's cursor only after storing every
record in that page, and repeat until the response array is empty. Resume from
the saved cursor on the next sync. IDs, not timestamps or row counts, define
the cursor. A replaced database requires resetting the client's cursor.

```sh
curl -i 'http://127.0.0.1:11500/meter/requests?after_id=0&limit=500'
# Use the response's next_after_id for the next page:
curl -i 'http://127.0.0.1:11500/meter/requests?after_id=500&limit=500'
```

`GET /meter/openapi.json` documents both modes and the response header.
Factory-api continues to use the legacy mode until its separate migration.

## Isolated live check

Build as `agent`. Do not restart the deployed meter or Ollama for validation.
Use an unused port and a temporary database:

```sh
cargo build --release --locked -p meter
db_dir=$(mktemp -d)
target/release/meter --listen 127.0.0.1:11500 \
  --upstream http://127.0.0.1:11434 --db-path "$db_dir/meter.db"
```

In another shell, send requests to `/api/version`, inspect `/meter/requests`,
then page using `after_id`. Stop only the test process afterward and remove
its temporary database. Forwarded live checks also create rows in the deployed
upstream meter, but do not alter its configuration or existing records.
