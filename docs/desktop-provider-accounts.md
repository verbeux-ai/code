# Verboo Desktop provider accounts

This document is the desktop/CLI boundary for the optional Claude and Codex
account manager. The CLI remains the only credential authority. Desktop sees
opaque local account IDs and sanitized status/usage data; it never receives an
access token, refresh token, ID token, provider subject, email, organization ID,
credential path, or raw provider response.

## Commands

The CLI exposes one versioned JSON envelope for each command:

```text
verboo provider-accounts capabilities
verboo provider-accounts list
verboo provider-accounts usage --provider codex|claude [--account <opaque-id>]
verboo provider-accounts set-default --provider <provider> --account <opaque-id>
verboo provider-accounts remove --provider <provider> --account <opaque-id>
```

Every response has `schemaVersion: 1` and either `ok: true, data` or
`ok: false, error: { code, message }`. `capabilities` returns
`provider_accounts_v1`, `provider_usage_v1`, and `loginTransport:
pty-slash-v1`. Provider login remains additive: `/codex login` and
`/claude login` add a new account when its provider identity is new; a
reconnect explicitly names the opaque local account.

## Account and usage fields

Account summaries may contain only:

- `provider` (`codex` or `claude`)
- opaque `accountId`, display label, `isDefault`
- `connectionState` (`connected` or `needs_reconnect`)
- optional sanitized plan label and validation timestamp

Usage snapshots contain the provider, opaque account ID, optional plan label,
fetch timestamp, and windows. A window has an opaque local ID, kind (`session`,
`weekly`, or `model-scoped-weekly`), display label, percentage used, optional
model scope, and optional reset timestamp.

The normalizer is provider-authoritative:

- Codex keeps the reported weekly window for the base limit and any separately
  reported scoped weekly limit. A five-hour primary window is not presented as
  a Codex weekly quota.
- Claude keeps reported five-hour and weekly windows. A Fable/model-scoped row
  appears only when the usage response includes that explicit scope; Pro never
  receives a fabricated Fable row.
- Missing resets, malformed limits, and unavailable provider windows are
  omitted rather than replaced with zeroes.

No quota state automatically selects, rotates, ranks, or recommends another
account. The user explicitly changes the default or selects an account for a
new process. An active conversation remains owned by the app, so switching the
account for a later turn does not delete its transcript, attachments, or
selections; the spawned CLI process receives one immutable `--provider-account`
ID.

## Storage and migration

The encrypted `providerAccounts` v1 record migrates the old scalar Codex and
Claude credentials idempotently. The old scalar fields remain as a rollback
mirror of the selected default account. Removing a non-default account does not
change that mirror; removing the default selects the deterministic remaining
account, and removing the final account clears the mirror only after the secure
write succeeds. Claude risk acceptance remains bound to the exact provider
subject and cannot be copied to another account.

Storage uses the existing native adapters on every supported desktop:

| Target | Secure storage |
| --- | --- |
| macOS arm64/x64 | Keychain |
| Windows x64 | Credential Locker |
| Linux x64 | Secret Service |

Plaintext fallback remains disabled.

## Verification matrix

The signed release matrix remains macOS arm64, macOS x64, Windows x64, and
Linux x64. The protocol is additive and does not change the desktop protocol
version or package version. The current evidence is intentionally separated:

- Live verified when available: Codex Plus and Claude Max.
- Fixture-only until matching accounts are supplied: Codex Pro/Spark and Claude
  Pro. Their parsers are covered by deterministic fixtures, not claimed as live
  account tests.

The upstream maintainer publishes the signed version and release. A feature PR
must not create a tag or GitHub release.
