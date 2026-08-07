# Chrome Web Store assets

Ready-to-upload assets for the Chrome Web Store listing. Generated from the real
extension UI (rendered via CDP at real side-panel width, then composited). No
extension source was modified to produce these — the sample chat/grants content
was injected into the live DOM at screenshot time only.

## Files

| File | Dimensions | Store field |
| --- | --- | --- |
| `verboo-chrome-<version>.zip` | — | The package to upload ("Upload new package") |
| `icon-128.png` | 128×128 | Store icon |
| `promo-tile-440x280.png` | 440×280 | Small promo tile |
| `screenshots/01-chat-approval.png` | 1280×800 | Screenshot — side panel + per-tool approval |
| `screenshots/02-settings-grants.png` | 1280×800 | Screenshot — permission modes + site grants |
| `screenshots/03-completed-answer.png` | 1280×800 | Screenshot — completed extraction turn |
| `screenshots/04-sign-in.png` | 1280×800 | Screenshot — Verboo account sign-in |

Upload at least 1 screenshot (the store allows up to 5). Order 01 → 04 tells the
story: what it does → how it's gated → the payoff → how to start.

## Privacy policy URL (required by the store)

Published via GitHub Pages from the repo's `gh-pages` branch:

**https://graseeel.github.io/verboo_app/privacy.html**

Paste that into the dashboard's *Privacy practices → Privacy policy URL* field.
Source of truth is `../privacy.html`; to update, edit it and re-copy to the
`gh-pages` branch (`index.html` + `privacy.html`).

## Rebuilding the package

```bash
cd extensions/verboo-chrome
npm run package   # writes dist/verboo-chrome-<version_name>.zip
```

The packager (`scripts/package.mjs`) ships only runtime files — it excludes
`*.test.js`, `*.ts`, `*.md`, and the `native-messaging/` protocol notes, so the
reviewer sees a minimal surface. Bump `version` / `version_name` in
`manifest.json` before each store submission.

## Before uploading an update

1. **OAuth login.** `src/auth/oauthConfig.js` ships the registered public client
   `verboo-code-chrome-extension`. Before uploading, verify that **Sign in**
   returns through the published redirect
   `https://nkfgdaoblgcbngpklgnmjkfdabpbmpee.chromiumapp.org/oauth/callback`.
2. **Listing copy.** Name, descriptions, category, permission justifications, and
   reviewer notes are all drafted in `../STORE_LISTING.md` — copy-paste ready.

## Português (Brasil)

Ativos prontos para upload na listagem da Chrome Web Store, gerados a partir da UI real da extensão (renderizada via CDP na largura real do side panel e composta depois). Nenhum código-fonte da extensão foi modificado para produzi-los — o conteúdo de exemplo foi injetado no DOM vivo apenas na hora do screenshot.

A tabela de arquivos, a URL da política de privacidade (GitHub Pages, branch `gh-pages`) e a receita de reempacotamento (`npm run package`, que exclui `*.test.js`, `*.ts`, `*.md` e `native-messaging/`) estão na seção em inglês acima. Suba pelo menos 1 screenshot (a loja aceita até 5); a ordem 01 → 04 conta a história: o que faz → como é controlado → o resultado → como começar.

Antes de subir uma atualização: (1) teste o login OAuth do build publicado, configurado com o public client `verboo-code-chrome-extension` e o redirect `https://nkfgdaoblgcbngpklgnmjkfdabpbmpee.chromiumapp.org/oauth/callback`; (2) os textos da listagem estão prontos em `../STORE_LISTING.md`.
