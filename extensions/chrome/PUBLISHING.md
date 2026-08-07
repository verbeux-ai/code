# Publishing the "Verboo in Chrome" extension and connecting the app

Practical guide. Order matters: **publish the extension → grab the ID → bake it into the app → distribute.**

## Why this order

The app needs the extension's 32-letter **ID** to configure the connection. That ID only exists after the **first upload** to the Chrome Web Store — and it is the **same for everyone** who installs the published extension. So: publish first, grab the ID, rebuild the app with it. The "ID slot" is ready at the top of `scripts/build-release-app.sh`.

## Step by step

1. **Developer account (once).** https://chrome.google.com/webstore/devconsole — one-time US$5 fee.
2. **Extension package.** `cd extensions/verboo-chrome && npm run package` (writes `dist/verboo-chrome-<version>.zip`).
3. **Privacy policy (already live).** https://graseeel.github.io/verboo_app/privacy.html — paste into the *Privacy policy* field.
4. **Create the item and upload the .zip.** As soon as the upload finishes the dashboard shows the 32-letter ID — note it down (used in step 7). No need to wait for review.
5. **Fill in the listing.** Copy from `STORE_LISTING.md`; screenshots in `store-assets/screenshots/`, tile in `store-assets/promo-tile-440x280.png`.
6. **Submit for review.** Public visibility → Submit. Broad permissions (`<all_urls>`, `scripting`, `nativeMessaging`) usually trigger manual review (hours to days).
7. **Bake the ID into the app and rebuild.** Paste the ID into `VERBOO_CHROME_EXTENSION_ID` (and optionally the store URL) in `scripts/build-release-app.sh`, run it, distribute the generated `.dmg`. Each user installs app + store extension, signs in with **their own** account, clicks **Configure** once.

## Release checks

1. **OAuth must remain testable by the reviewer.** The public client `verboo-code-chrome-extension` is configured for the published extension redirect. Verify "Sign in" on the Chrome Web Store build before submitting an update.
2. **The ID is only permanent from the first upload.** Deleting and recreating the item changes the ID — and an app baked with the old ID stops matching. Never delete the item after baking the ID.

## Distributing to other people

Each person: installs your `.dmg` (ID already baked), installs the extension from the store (same ID for everyone), signs in with their own Verboo account, clicks **Configure** once on their machine. The ID is the extension's identity; the **account** is each user's own.

## Português (Brasil)

### Publicar a extensão e conectar ao app

Guia prático. A ordem importa: **publicar a extensão → pegar o ID → gravar no app → distribuir.**

### Por que nesta ordem

O app precisa saber o **ID** da extensão (32 letras) para configurar a conexão.
Esse ID só existe depois do **primeiro upload** na Chrome Web Store — e é o
**mesmo para todos** que instalarem a extensão publicada. Por isso publica-se
primeiro, pega-se o ID, e recompila-se o app com ele.

O "lugar do ID" no app já está pronto: `scripts/build-release-app.sh` (topo do
arquivo). Só colar o ID e rodar o script.

### Passo a passo

### 1. Conta de desenvolvedor (uma vez)
- Entre em https://chrome.google.com/webstore/devconsole
- Pague a taxa única de US$ 5.

### 2. Pacote da extensão (já pronto)
```bash
cd extensions/verboo-chrome
npm run package   # gera dist/verboo-chrome-<versão>.zip
```
Também há uma cópia em `store-assets/`.

### 3. Política de privacidade (já no ar)
Já publicada via GitHub Pages:
**https://graseeel.github.io/verboo_app/privacy.html**
Cole essa URL no campo *Privacy policy* do painel.

### 4. Criar o item e subir o .zip
- No dashboard: **Add new item** → suba o `.zip`.
- **Assim que o upload termina, o painel mostra o ID de 32 letras.**
  Anote — é ele que vai no app (passo 7). Não precisa esperar a análise
  para pegar o ID.

### 5. Preencher a listagem
Textos prontos em `STORE_LISTING.md` (nome, descrições, categoria, permissões,
notas para o revisor). Screenshots prontos em `store-assets/screenshots/` e o
tile em `store-assets/promo-tile-440x280.png`.

### 6. Enviar para análise
- Marque visibilidade (Público) e envie (**Submit for review**).
- Análise costuma levar de horas a alguns dias (as permissões amplas —
  `<all_urls>`, `scripting`, `nativeMessaging` — puxam revisão manual).

### 7. Gravar o ID no app e recompilar
- Abra `scripts/build-release-app.sh`.
- Cole o ID (passo 4) em `VERBOO_CHROME_EXTENSION_ID="..."`.
- (Opcional) cole a URL da loja em `VERBOO_CHROME_WEB_STORE_URL="..."`.
- Rode:
  ```bash
  ./scripts/build-release-app.sh
  ```
- Distribua o `.dmg` gerado. Cada usuário instala o app + a extensão da loja,
  loga **na conta dele**, clica **Configurar** uma vez → funciona.

### Verificações antes de publicar

1. **O OAuth precisa continuar testável pelo revisor.** O public client
   `verboo-code-chrome-extension` está configurado para o redirect da extensão
   publicada. Teste o botão **Sign in** no build da Chrome Web Store antes de
   enviar uma atualização.

2. **O ID só é permanente a partir do primeiro upload.** Se você deletar o item
   e recriar, o ID muda — e o app gravado com o ID antigo para de casar. Não
   delete o item depois de gravar o ID no app.

### Distribuir para outras pessoas — o que cada um faz
1. Instala o app (o `.dmg` que você gerou, já com o ID gravado).
2. Instala a extensão pela loja (mesmo ID para todos).
3. Entra na própria conta Verboo pela extensão.
4. Clica **Configurar** uma vez na máquina dele.
O ID é igual para todos (identidade da extensão); a **conta** é a de cada um
(vem do login no CLI/app). Ninguém depende de você.
