# Provider regression checks

Run `pnpm check` for the normal credential-free checks. Live provider tests are
opt-in and use real service resources. Keep credentials in ignored environment files.
Local Chrome requires an explicit `STAGEHAND_BROWSER=local` setting.

## Browser infrastructure

Set `NOTTE_API_KEY`, `NOTTE_API_URL`, and `STAGEHAND_BROWSER=notte` in an ignored environment
file, then run `pnpm test:notte:live`. The suite checks browser controls, saved profiles,
handoff, synthetic credential entry with default recording, and Eve lifecycle cleanup.

## 1Password login and OTP

Use a dedicated test vault with a Login item titled exactly
`Bell integration test (authenticationtest.com)`. Give it the website
`https://authenticationtest.com` and the public test username, password, and OTP seed shown
on [the test site's TOTP challenge](https://authenticationtest.com/totpChallenge/).
Do not point the test at a personal or production login.

Configure `NOTTE_API_KEY` and either `OP_SERVICE_ACCOUNT_TOKEN` or desktop integration
through `OP_ACCOUNT`. From the repository root:

```sh
BELL_LIVE_ONEPASSWORD=1 STAGEHAND_BROWSER=notte \
  node --env-file-if-exists=.env --env-file-if-exists=.env.local \
  node_modules/vitest/vitest.mjs run tests/browser/onepassword-login-real.test.ts
```

The test resolves the OTP after navigation, submits the dedicated test login, checks the
success page, and asserts that the returned result and traces omit the credentials.
Without the dedicated fixture, report this check as unverified even if vault listing works.

## Saved Notte Context

With the Notte environment loaded, run:

```sh
BELL_LIVE_CONTEXT=1 STAGEHAND_BROWSER=notte pnpm exec vitest run tests/browser/context-save-real.test.ts
```

This writes a synthetic example.com cookie, releases the writer, starts a reader with the
same Context, and checks the restored cookie. It then releases both browsers and deletes the
temporary Context. Cleanup failures must fail the check rather than silently leaving resources.
