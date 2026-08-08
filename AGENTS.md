# Repository instructions

## Desktop release signing

Every desktop CLI release must be signed with Minisign by the `release` GitHub Actions environment. The release workflow must read these environment secrets:

- `VERBOO_DESKTOP_MINISIGN_SECRET_KEY_B64`: the complete Minisign secret-key file encoded as single-line base64.
- `VERBOO_DESKTOP_MINISIGN_PUBLIC_KEY`: the complete two-line Minisign public-key file.

Before publishing a version, confirm that both secret names exist in the `release` environment and that the desktop signing job is enabled. A missing signing configuration must fail the release; never publish unsigned desktop CLI update assets.

Never print, log, commit, upload as an artifact, or send the private key or its base64 value. Do not rotate or replace the signing pair as part of a routine release. Follow `docs/desktop-cli-distribution.md` for publishing, verification, rotation, and compromise handling.
