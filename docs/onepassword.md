# Personal 1Password through Bell

Personal Agentic Autofill remains disabled: keep `ONEPASSWORD_ENABLED=false` and
`BELL_ONEPASSWORD_EXTENSION_ID` unset. Notte's public session API does not support uploading
Bell's additional personal 1Password extension. A supplied extension marker is rejected at
hosted browser launch instead of pretending that the extension is installed.

The existing per-Linq-sender OAuth, encrypted connection storage, approval, disconnect, and
private-browser guards remain implemented for recovery and future extension support. These
synthetic tests do not establish a working personal login on Notte. Operator SDK/CLI vault
access is separate and remains unavailable to messaging senders.

Hosted operator vault login uses Notte's default session recording and network logging without
an additional recording opt-in. See [browser runtime](browser-runtime.md).

Do not enable personal Autofill until Notte supports the required unmodified extensions together,
then verify two-sender OAuth isolation, approval, same-session fill and follow-up browsing,
revocation, restart recovery, and failed-fill quarantine against the deployed combination.
The existing `migrations/002_onepassword.sql` and encryption-key settings are retained for
callback completion and disconnect of existing records. Keep encryption keys backed up; removing
them prevents recovery and revocation.
