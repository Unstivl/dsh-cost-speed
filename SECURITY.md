# Security policy

## Supported versions

Security fixes land on the latest `0.2.x` release. The plugin targets DSH `0.2.1-rc.3` and newer, below `0.3.0`.

## What the plugin can access

`dsh-cost-speed` has two halves.

The host half runs inside the DSH process with that process's Node privileges. It can read local session logs and write under `~/.dsh/cost-monitor/`. It uses this access to backfill token counts, keep the one-minute ledger and serve the panel.

The browser half runs in the DSH web client. It only calls same-origin routes under `/dsh-cost-speed/`; it does not load remote scripts, fonts or images.

The plugin sends no outbound network requests. It reads no prompts, replies or credentials into its data files; the ledger stores provider, model, token counts, cost and timestamps.

## Local HTTP surface

| Route | Method | Purpose |
| --- | --- | --- |
| `/dsh-cost-speed/snapshot` | GET | aggregated cost buckets |
| `/dsh-cost-speed/live` | GET | live TPS and context slice |
| `/dsh-cost-speed/config` | GET / POST | read or replace the price table |
| `/dsh-cost-speed/diag` | GET | local diagnostics counters |
| `/dsh-cost-speed/selftest` | GET | liveness marker |
| `/dsh-cost-speed/import` | POST | replace imported bill history |

Every route checks, in order:

1. `Sec-Fetch-Site: cross-site` is rejected.
2. When `Origin` is present, its host must equal the `Host` header.
3. When the web server is bound to a loopback address, `Host` must name a loopback host and the peer address must be loopback. This also blocks DNS-rebinding pages.

Write routes accept only `POST` with `Content-Type: application/json`. Bodies are bounded (64 KB for prices, 512 KB for bill history) and parsed after the origin check. Errors returned to the browser are generic; details stay in the host log.

Local scripts such as `curl` send no `Origin` and remain allowed on a loopback bind. A reverse proxy that terminates a public hostname should keep the profile behind DSH's own access control; the loopback restriction then does not apply, and the origin comparison is the remaining gate.

## Data at rest

- `ledger.json`: one-minute usage ledger, 400 days, at most 200k rows.
- `pricing.json`: price rules and a note.
- `history-bill.json`: optional imported hourly totals.

Files are created with mode `0600` where the platform honours POSIX bits. On Windows the mode is effectively advisory; the data directory inherits the user profile ACL. The files are not encrypted. Anyone who can read the user's home directory can read them.

## Supply chain

The package has no runtime npm dependencies and no `postinstall` or `prepare` script. The only third-party code is the tokenizer port documented in `THIRD_PARTY_NOTICES.md`, shipped as plain JavaScript with its data file.

Installing a DSH plugin executes its host half inside the DSH process. Treat a plugin as code with full user privileges and review it before installing.

## Out of scope

- A local process running as the same user can read the data files or call the routes directly.
- A malicious DSH build or another plugin can bypass these checks from inside the process.
- Estimates can differ from the provider invoice; this is not a billing authority.

## Reporting

Open a private security advisory on the GitHub repository (Security → Report a vulnerability). Do not file a public issue for an unfixed problem. Include the version, the DSH version and a minimal reproduction. Please allow time for a fix before disclosure.