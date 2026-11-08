# dsh-cost-speed

A local cost and speed monitor for DeepSeek Harness. The pill above the composer shows today's estimated cost by default; hovering opens hour, day, week and month charts. While a response streams it also shows tokens per second, time to first token and context usage.

## Features

- Estimates tokens with the real DeepSeek BPE and converts them with a user-editable price table.
- Four views: hour (minute line), day (24 bars), week (Mon-Sun), month (calendar heat map). The dock opens on the day view.
- Live readout: TPS, time to first token, context usage and cache hits.
- Edit prices in the panel; they persist locally across restarts.
- Everything stays on this machine. No outbound requests.

## Compatibility

- DSH `0.2.1-rc.3` or newer, below `0.3.0`.
- The browser half registers on the `web` platform and works in both Desktop and Web builds.
- The host half uses only Node built-ins and the DSH `llm/stream` event.

## Install

From the sidebar open Plugins, choose Add plugin, and paste:

```
https://github.com/Unstivl/dsh-cost-speed
```

Or from a terminal:

```bash
dsh plugin --profile desktop add github:Unstivl/dsh-cost-speed
```

New bundles are enabled on install. Use the row switch on the plugin card to turn the host half and the pill off and on. The choice is written to the profile's `cordis.patch.yml` and survives restarts.

## Pricing

The shipped table is an example using DeepSeek official API off-peak prices, in CNY per million tokens:

| Model | Input | Output | Cache read |
| --- | --- | --- | --- |
| deepseek-flash | 1 | 4 | 0.02 |
| deepseek-v4-flash | 1 | 4 | 0.02 |
| deepseek-v4-flash-vision-exp | 1 | 4 | 0.02 |
| deepseek-v4-pro | 4.5 | 13.5 | 0.15 |

Peak hours (Beijing time, Monday to Friday 09:00-12:00 and 14:00-18:00) are doubled. Add rules for other providers and models. A model with no matching rule still counts tokens but is reported as unpriced; it is never silently billed at zero.

Rules live in `~/.dsh/cost-monitor/pricing.json` and can also be edited from the card. `provider` and `model` accept `*`. `free: true` marks a route that is deliberately zero-priced, which is different from having no price. Keep at least one `*/*` fallback rule at the end.

## Data and privacy

Everything is under `~/.dsh/cost-monitor/`: `ledger.json` (one-minute usage ledger, 400 days, at most 200k rows), `pricing.json`, and an optional `history-bill.json` imported from a provider bill. On boot the plugin reads local session logs to backfill usage; it keeps token counts, model names and sources only, never prompts or replies. Nothing is uploaded.

## Security

The plugin registers read routes on the local HTTP server. `/config` and `/import` accept only `POST` with `application/json`; every route checks `Origin` / `Host` and `Sec-Fetch-Site`, which blocks cross-site writes and DNS rebinding. Writes go through a temporary file and rename, and files are created with mode `0600` where the platform honours it. There is no `postinstall` and no runtime npm dependency.

Host plugins run inside the DSH process with that process's Node privileges. Read the code before installing one. See [SECURITY.md](SECURITY.md) to report an issue.

## Development

```
lib/index.js          host half: capture, pricing, aggregation, HTTP routes
lib/client.js         browser half: pill, four-view card, price editor
lib/tokenizer/        DeepSeek BPE and incremental decoding
cordis.patch.yml      bundle layer: inserts the cost-speed row
smoke/check.mjs       dependency-free smoke checks
```

There is no build step; edit the JavaScript in `lib/`. Run `node smoke/check.mjs`. Never commit `ledger.json`, `history-bill.json` or a real bill export.

## Limitations

- Amounts are estimates based on reported token counts and the local table; they can differ from the final invoice.
- The currency symbol is fixed to CNY; other currencies require editing the numbers and the symbol does not follow.
- Web platform only.
- Windows ignores most POSIX permission bits; isolation relies on the user profile ACL.

## License

MIT. Third-party notices for the tokenizer are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).