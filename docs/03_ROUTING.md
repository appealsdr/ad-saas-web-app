# Routing & Layout Architecture

SvelteKit's file-system routing. Two route groups keep auth and app layouts completely separate.

---

## Route Groups

```
src/routes/
├── +layout.svelte          # Root layout — loads app.css, seeds auth store
├── +layout.server.ts       # Passes locals.user to all pages as data.user
├── +page.server.ts         # / → redirect to /dashboard
│
├── (auth)/                 # Full-screen centered layout (no sidebar)
│   ├── +layout.svelte      # auth-bg gradient wrapper
│   ├── login/
│   └── register/
│
├── (app)/                  # Protected sidebar layout
│   ├── +layout.svelte      # AppShell: Sidebar + main-content column
│   ├── +layout.server.ts   # Guard: redirect if not logged in
│   ├── dashboard/
│   ├── accounts/
│   ├── stores/
│   ├── issues/
│   ├── payments/
│   └── services/
│
└── auth/                   # Bare server-side OAuth handlers (no layout)
    ├── logout/
    └── google/
        ├── +server.ts      # Initiates Google redirect
        └── callback/
            └── +server.ts  # Handles Google callback
```

---

## Adding a Page

1. Create `src/routes/(app)/my-feature/+page.svelte`
2. Optional: `+page.server.ts` for server-side data loading
3. Add to `navItems` in `Sidebar.svelte`

### Page template
```svelte
<script lang="ts">
  import Topbar from '$components/layout/Topbar.svelte';
  // import type { PageData } from './$types';
  // export let data: PageData;
</script>

<svelte:head><title>My Feature — Appeals Doctor</title></svelte:head>

<Topbar title="My Feature" subtitle="Description">
  <!-- optional topbar right-side buttons via slot -->
</Topbar>

<div class="content-area">
  <!-- page content -->
</div>

<style>
  .content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }
</style>
```

---

## Data Loading Pattern

Server-side data fetches happen in `+page.server.ts`. The data is passed to the page as props:

```typescript
// +page.server.ts
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, params }) => {
  // TODO: fetch from DB or Salesforce via SalesforceClient
  return { issues: [] };
};
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
  import type { PageData } from './$types';
  export let data: PageData;
  // data.issues is now available
</script>
```

---

## API Routes (Future)

Mobile apps will need REST endpoints. Add these as SvelteKit server routes:

```
src/routes/api/
├── issues/
│   ├── +server.ts        # GET /api/issues, POST /api/issues
│   └── [id]/
│       └── +server.ts    # GET /api/issues/:id, PATCH, DELETE
├── accounts/
└── stores/
```

Pattern:
```typescript
// src/routes/api/issues/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
  // const issues = await db.query...
  return json({ data: [] });
};
```

---

## Salesforce Sync Integration Point

Each route's `+page.server.ts` load function is where Salesforce data comes in:

```typescript
// Future: issues/+page.server.ts
import { SalesforceClient } from '$lib/server/salesforce/client';

export const load: PageServerLoad = async ({ locals }) => {
  const sfdc = SalesforceClient.getInstance();
  const cases = await sfdc.query(
    `SELECT Id, Subject, Status, Priority FROM Case WHERE AccountId = '${locals.user.sfdcAccountId}' ORDER BY CreatedDate DESC LIMIT 50`
  );
  return { issues: cases.records };
};
```
