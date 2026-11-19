REDDIT READER v1.0.73 — PUBLIC DISTRIBUTION
=============================================
This is a clean, unconfigured copy of the Chrome/Brave Manifest V3 extension.
It has NO personal feeds, browsing history, backups, OAuth tokens, Google Drive
credentials, API keys, or personal account identifiers built into the ZIP.

The manifest's fixed public key has been deliberately removed. Chrome assigns
an extension ID for each unpacked install. The version remains 1.0.73.

INSTALL:
1. Extract the ZIP to a new folder.
2. In Chrome/Brave, open chrome://extensions or brave://extensions.
3. Enable Developer mode, then choose Load unpacked and select that folder.
4. Configure your own Reddit OAuth installed-app client under Settings.
5. Google Drive synchronization is optional and needs YOUR Google OAuth client.
   Your redirect URL depends on the extension ID assigned on your computer.

PRIVACY:
- User data is created and stored only after someone installs/uses the extension.
- Do NOT share your own settings backup JSON: the backup exporter intentionally
  includes account tokens and other private data in plaintext.
- The ZIP includes no user database or browser profile.
- Every new installation starts with unconfigured accounts and empty feeds.

PORTUGUÊS:
Esta versão pública não contém feeds, histórico, tokens, credenciais Google
ou cópias de segurança pessoais. Não partilhes ficheiros JSON exportados:
podem conter tokens e informação privada. Cada utilizador deve configurar
as suas próprias credenciais OAuth (Reddit e, opcionalmente, Google Drive).
