# Salesforce sign-up link (AD-1934)

Link: `https://<app>/register/link?t=<token>`

Token = `base64url(JSON) + "." + base64url(HMAC-SHA256(SIGNUP_LINK_SECRET, base64url(JSON)))`
JSON: `{"a":"<Account Id>","c":"<Contact Id>","k":"<ServiceContract Id, optional>","n":"<unique nonce>","e":<expiry unix seconds>}`

Behavior: the page reads the live Account/Contact/Stores from Salesforce, lets the client edit and set a
password, then creates the app account/user **linked** to the existing records (no new SF Account/Contact),
mirrors the Account's `Store__c` records into `stores`, writes the edits back to the existing SF records,
and marks the link used (`signup_links`, migration 034). Expired, tampered or reused links are rejected.

Config: set `SIGNUP_LINK_SECRET` (shared with the Salesforce Apex that builds the link).
Helper for tests/CLI: `createSignupToken()` in `src/lib/server/auth/signup_link.ts`.
