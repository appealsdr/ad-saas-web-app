# Authentication

---

## Current State (Dev Stub)

The auth system is scaffolded end-to-end but uses stubs in place of real DB calls. The flow is wired and ready — replace the `// TODO` sections with real logic.

---

## Flow

```
User → POST /login (form action)
  → hooks.server.ts reads `session` cookie → locals.user
  → +layout.server.ts passes user to all pages
  → auth Svelte store hydrated client-side
```

### Session lifecycle
- **Login**: Server action validates credentials → signs JWT (HS256) → sets `HttpOnly Secure SameSite=Strict` cookie with 3h `maxAge`
- **Every request**: `hooks.server.ts` reads the cookie → validates JWT signature → queries `sessions` table to confirm not revoked → attaches `locals.user`
- **Logout**: POST `/auth/logout` → deletes session row from DB → `cookies.delete('session')` → redirect to `/login`
- **Expiry**: Cookie `maxAge` is 3h; `sessions.expires_at` is also 3h. Both must be valid.

---

## Files

| File | Role |
|------|------|
| `src/hooks.server.ts` | Auth middleware — reads cookie, populates `locals.user` |
| `src/app.d.ts` | Declares `App.Locals.user` type |
| `src/routes/(auth)/login/` | Login page + server action |
| `src/routes/(auth)/register/` | Registration page + server action |
| `src/routes/(app)/+layout.server.ts` | Route guard — redirects if not logged in |
| `src/routes/auth/logout/` | POST action — clears cookie |
| `src/routes/auth/google/+server.ts` | Starts Google OAuth redirect |
| `src/routes/auth/google/callback/+server.ts` | Handles Google callback |
| `src/lib/stores/auth.ts` | Client-side Svelte auth store |

---

## Implementing Real Auth (TODOs)

### 1. Password Login

In `src/routes/(auth)/login/+page.server.ts`:
```typescript
import { verify } from 'argon2';
import { db } from '$lib/server/db';
import { signJwt } from '$lib/server/jwt';

const user = await db.query.users.findFirst({ where: eq(users.email, email) });
if (!user || !await verify(user.passwordHash, password)) {
  return fail(401, { error: 'Invalid credentials.' });
}

const sessionId = crypto.randomUUID();
await db.insert(sessions).values({
  id: sessionId,
  userId: user.id,
  expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
  ipAddress: event.getClientAddress()
});

const token = signJwt({ sub: user.id, sid: sessionId });
cookies.set('session', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 10800 });
```

### 2. JWT Validation (hooks.server.ts)

```typescript
import { verifyJwt } from '$lib/server/jwt';
const payload = verifyJwt(sessionToken);
const session = await db.query.sessions.findFirst({
  where: and(eq(sessions.id, payload.sid), gt(sessions.expiresAt, new Date()))
});
if (session) event.locals.user = await getUserById(payload.sub);
```

### 3. Google OAuth Callback

```typescript
// Exchange code for tokens
const tokens = await exchangeGoogleCode(code, redirectUri);
// Fetch Google user info
const googleUser = await getGoogleUserInfo(tokens.access_token);
// Upsert user
const user = await upsertOAuthUser({ provider: 'google', providerUid: googleUser.id, email: googleUser.email, displayName: googleUser.name });
// Create session + cookie (same as password login above)
```

---

## Route Protection

`src/routes/(app)/+layout.server.ts` checks `locals.user`:
```typescript
if (!locals.user) throw redirect(303, '/login');
```

All routes inside the `(app)` group are automatically protected. Public routes (`/login`, `/register`, `/auth/*`) are outside this group and never redirected.

---

## Client-side Auth Store

`$stores/auth` is a Svelte writable that mirrors the server session:

```typescript
import { auth, isLoggedIn, userInitials } from '$stores/auth';

// In a component:
$auth          // User | null
$isLoggedIn    // boolean
$userInitials  // "JD" for "Jane Doe"
```

The store is seeded in `src/routes/+layout.svelte` from `data.user` (passed by `+layout.server.ts`).
