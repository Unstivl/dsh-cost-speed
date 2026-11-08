# Changelog

## 0.2.1 - 2026-11-08

- Make the Chinese README the default page (README.md) and move the English one to README.en.md; both link to each other.
- Add a Credits section naming the project this package ports from, next to the existing THIRD_PARTY_NOTICES.md.

## 0.2.0 - 2026-10-25

- Package the plugin as a DSH bundle (`dsh.bundle.patch`) so the plugin panel can install it, show its card and toggle its row.
- Open the dock on the day view by default.
- Rename the package to `dsh-cost-speed`; the old `@deepseek-ai/dsh-cost-monitor` name collided with several community plugins.
- Add same-origin, `Sec-Fetch-Site` and loopback-host checks to every HTTP route; write routes now require `POST` with `application/json`.
- Bound request bodies, return generic error bodies, and create data files with `0600` where supported.
- Replace the personal price table with a DeepSeek official API example and a catch-all rule; existing installations keep their own `pricing.json`.
- Add README (Chinese and English), SECURITY.md, smoke checks and this changelog. No build step, no runtime dependencies.

## 0.1.0

- Internal version: live capture through `llm/stream`, minute buckets, hour/day/week/month views, TPS and context readout, editable price table, optional bill import.