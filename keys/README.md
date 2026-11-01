# keys/

Local-only secret material. The contents of this folder are **gitignored**
(only `.gitkeep` and this README are tracked).

## What goes here

Drop the RSA private key whose matching **certificate** is uploaded to the
Salesforce Connected App. The default path the loader expects is:

```
samdoctor-web/keys/server.key
```

If you want to put it somewhere else, set `SFDC_PRIVATE_KEY_PATH` in `.env`
(absolute path, or relative to `samdoctor-web/`).

## Required format

- **PEM** (text starting with `-----BEGIN PRIVATE KEY-----` for PKCS#8 or
  `-----BEGIN RSA PRIVATE KEY-----` for PKCS#1)
- **Unencrypted** — JWT Bearer flow has no place to enter a passphrase, so
  the file must not be password-protected.

If your file is encrypted (header reads `ENCRYPTED PRIVATE KEY`), decrypt it:

```bash
openssl pkcs8 -topk8 -nocrypt -in encrypted-server.key -out keys/server.key
chmod 600 keys/server.key
```

## Generating a new keypair (sandbox)

```bash
# From samdoctor-web/
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout keys/server.key \
  -out   keys/server.crt \
  -subj "/CN=samdoctor-sandbox"
chmod 600 keys/server.key
```

Upload `keys/server.crt` to the Salesforce Connected App under
**Use digital signatures**. Keep `keys/server.key` on the machine
running SvelteKit.

## File permissions

Set the file to read-only for your user — the loader doesn't enforce this,
but it's a good habit:

```bash
chmod 600 keys/server.key
```
