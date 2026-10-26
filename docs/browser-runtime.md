# Browser runtime

Notte owns hosted browser sessions, managed proxies, persisted browser profiles, and Live View.
Stagehand 4.2.1 controls the browser over the CDP URL returned by Notte. No Browserbase account,
API key, session, Context, or hosted callback executor is used. The Stagehand package name still
contains `@browserbasehq` because it is the browser-control SDK.

## Configuration

Use Node.js 24 and the settings in `.env.example`:

| Variable | Purpose |
| --- | --- |
| `NOTTE_API_KEY` | Server-only key for the intended Notte workspace. |
| `NOTTE_API_URL` | Exact API origin, default `https://api.notte.cc`. |
| `STAGEHAND_BROWSER` | Defaults to `notte` for hosted sessions. Explicitly set `local` for local fixtures. |
| `NOTTE_PROFILE_ID` | Optional existing Notte profile ID. Existing Context tool names remain available. |
| `NOTTE_MAX_DURATION_MINUTES` | Maximum session lifetime, default 30; must fit the workspace plan. |
| `BELL_BROWSER_IDLE_MS` | Bell inactivity cleanup, default 30 minutes. |
| `BELL_CONTEXT_METADATA_PATH` | Local profile labels, default `.bell/notte-contexts.json`. |
| `BELL_DRAFT_CONTEXT_TTL_MS` | Unused draft profile retention, default seven days. |
| `BELL_PUBLIC_URL` | Reachable HTTPS Bell origin for handoff; loopback HTTP is allowed locally. |
| `BELL_HANDOFF_SECRET` | Handoff encryption secret, at least 32 bytes. |
| `BELL_OPERATOR_USERNAME` / `BELL_OPERATOR_PASSWORD` | Optional operator HTTP Basic credentials; password at least 32 bytes. |

Notte records browser sessions and network activity by default. Hosted vault login, Baselayer
proof presentation, and Link card entry use these defaults without an additional recording opt-in.
Credentials still stay out of model-visible tool results; Link's browser quarantine remains
enforced after card entry.

Personal 1Password Agentic Autofill remains disabled. Notte's public API cannot upload the
additional personal extension. Keep `ONEPASSWORD_ENABLED=false` and `BELL_ONEPASSWORD_EXTENSION_ID`
unset. The latter is a reserved private-browser marker, not a supported Notte upload ID.
Operator 1Password SDK/CLI and existing encrypted local vaults remain available.
Operator vault tools remain unavailable to Linq senders.

## Lifecycle and controls

One conversation reuses one Notte browser. Bell stores only its session/profile IDs and safe page
metadata in Eve state, never CDP or viewer capabilities. A worker can retrieve an active session
and reconnect Stagehand. A confirmed missing or closed session can be replaced with its profile;
a transport or attachment failure is reported without silently creating another browser.

Notte uses its deployed Stagehand extension. The pinned SDK matches the tested runtime. A
protocol mismatch fails attachment and releases the newly created session. Browser operations run directly through Stagehand page methods, not
Browserbase's hosted experimental callback batches. Navigation, snapshot targets, screenshots,
operation locks, cancellation, and terminal cleanup retain their Bell interfaces.

A blocked snapshot reports the denial; use human handoff for steps that need a person.

Optional browser locations map to Notte's lowercase country and city fields. State-level
selection is rejected because Notte does not expose that field.

## Profiles and handoff

The existing `context_create`, `context_list`, `context_select`, and `context_save` tools manage
Notte profiles. Drafts are hidden until saved. Writable profiles persist on Notte session stop;
Bell stops the session before closing the Stagehand/CDP browser so cookies and storage can save.
Profile labels remain scoped to one operator and process. Multi-instance deployments need shared
metadata storage and user isolation.

Handoff tokens remain encrypted, scoped to the current session, and valid for ten minutes.
Bell resolves a fresh Notte session-scoped Live View capability server-side. The API key is never
placed in the handoff page or returned viewer URL. Link expiry prevents reopening Bell's link;
it does not revoke an already opened provider viewer. Close the conversation to end browser access.

## Migration and checks

Finish old Browserbase conversations and release their browsers before deploying this version.
Browserbase Context IDs cannot become Notte profile IDs. Bell uses the separate `bell.notte.v1`
Eve namespace; create new conversations and Notte profiles instead of resuming old provider state.
The default profile-label file is separate from the old Browserbase Context file.

Run `pnpm check` for unit tests, types, lint, and build. `pnpm test:notte:live` requires an explicitly
configured Notte environment and tests real browser controls, screenshots, reuse, handoff, release,
and cookie persistence. `BELL_LIVE_RETIREMENT=1 pnpm test:retirement:live` exercises the running Eve
application. Provider tests create only their own sessions and synthetic profiles, and clean them up.
