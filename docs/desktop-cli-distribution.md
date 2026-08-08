# Signed Verboo Desktop CLI distribution

Verboo Desktop updates the CLI independently from the desktop application. A published CLI release therefore carries four target-specific archives plus a manifest and its detached Minisign signature.

## Release assets

Every eligible `vMAJOR.MINOR.PATCH` release contains exactly:

- `verboo-cli-<version>-aarch64-apple-darwin.tar.gz`
- `verboo-cli-<version>-x86_64-apple-darwin.tar.gz`
- `verboo-cli-<version>-x86_64-pc-windows-msvc.tar.gz`
- `verboo-cli-<version>-x86_64-unknown-linux-gnu.tar.gz`
- `verboo-cli-manifest.json`
- `verboo-cli-manifest.minisig`

The native jobs materialize `dist/cli.mjs` and the production dependency closure on matching runners. Archives contain no Node.js executable. Verboo Desktop supplies its own pinned Node runtime.

## One-time protected environment setup

The repository owner performs these steps. The private key must never be committed, stored in repository variables, uploaded as an Actions artifact, or exposed to pull-request workflows.

1. On a trusted offline machine, install Minisign and create an unencrypted automation key:

   ```bash
   minisign -G -W -p verboo-desktop-cli.pub -s verboo-desktop-cli.key
   ```

2. Preserve `verboo-desktop-cli.key` in the project's encrypted key backup.

3. Base64-encode the entire secret-key file as one line:

   ```bash
   base64 < verboo-desktop-cli.key | tr -d '\n'
   ```

4. In the protected GitHub Actions environment named `release`, create:

   - `VERBOO_DESKTOP_MINISIGN_SECRET_KEY_B64`: the one-line base64 value from step 3.
   - `VERBOO_DESKTOP_MINISIGN_PUBLIC_KEY`: the complete two-line contents of `verboo-desktop-cli.pub`.

5. Require maintainer approval for the `release` environment and restrict it to protected release tags.

The release job fails before signing when either secret is absent. Fork pull requests never receive these values and cannot publish GitHub release assets.

## Publishing

1. Ensure `package.json.version` is the intended version and the Git tag is exactly `v<package.json.version>`.
2. Publish the GitHub release through the normal project release flow.
3. Wait for `Deploy Release / Sign and publish desktop CLI assets` to finish.
4. Confirm that all six assets above are attached to the same immutable tag.
5. Confirm the job log includes `Verified Verboo CLI <version>` before the upload step.

The aggregator recalculates every archive's byte size and SHA-256 instead of trusting matrix-job metadata. It signs the exact bytes of `verboo-cli-manifest.json`, verifies that signature again, inspects archive paths and entry types, and only then uploads the set.

## Pull-request validation

Pull requests run the packaging scripts on the same four native runner families. These jobs exercise the platform-specific dependency closure and `--version` smoke but only upload short-lived Actions artifacts. They do not create or mutate a GitHub release.

The focused local gate is:

```bash
bun run desktop:test
bun run build
node dist/cli.mjs --version
```

The open-source mirror currently has unrelated repository-wide TypeScript errors, so this distribution work relies on the release build, native matrix, and focused tests rather than claiming a clean global `tsc --noEmit` baseline.

## Key rotation and compromise

For planned rotation, first ship a desktop application release that trusts both the current and replacement public keys. Only after that desktop release is available should the release environment switch to the replacement secret/public pair. A later desktop release may remove the retired key.

If the private key may be compromised, stop publishing desktop CLI assets immediately. Ship a desktop trust-root update that rejects the compromised key, then configure a replacement key and resume CLI publication. Do not publish a replacement signature under the old tag or reuse an existing asset name for different bytes.
