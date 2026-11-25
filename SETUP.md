# SamDoctor Web — Developer Setup

## Prerequisites

- Node.js 22+
- npm 10+
- Docker (for local Postgres + Redis)

---

## 1. Install dependencies

```bash
cd samdoctor-web
npm install
```

---

## 2. Environment

```bash
cp .env.example .env
# Fill in SFDC / Google / AWS values for local development
# DATABASE_URL and REDIS_URL can stay as-is if using Docker below
```

---

## 3. Local services (Postgres + Redis)

```bash
# From repo root
docker compose up -d
```

Runs:
- PostgreSQL 16 on port 5432 (`samdoctor` database)
- Redis 7 on port 6379

---

## 4. Run the dev server

```bash
npm run dev
# → http://localhost:5173
```

Hot-reload is on. SvelteKit will rebuild affected routes automatically.

---

## Stripe webhook

Each environment needs a webhook endpoint in the Stripe dashboard (Developers → Webhooks):
URL `<origin>/api/stripe/webhook`, signing secret in `STRIPE_WEBHOOK_SECRET`. Enable these events:

| Event | Used for |
|---|---|
| `payment_intent.succeeded` | Stores a one-off purchase if the customer never reached `/checkout/success`; records deposit-balance payments |
| `checkout.session.completed` | Stores a recurring subscription if the customer never reached `/checkout/success` |
| `checkout.session.async_payment_succeeded` | The same, for payment methods that settle after checkout (e.g. bank debits) |
| `customer.subscription.updated` | Cancellation requested or withdrawn |
| `customer.subscription.deleted` | Subscription ended |
| `invoice.payment_succeeded` | Subscription renewal payments |

Locally: `stripe listen --forward-to localhost:5173/api/stripe/webhook` and use the secret it prints.

A purchase the webhook cannot store (e.g. the Salesforce price book is unreadable) fails the delivery, and Stripe
retries it. Once the contract exists in the app, a failed Salesforce write is **not** retried: the contract shows
`sync_status = 'failed'` (or stays `pending` if the server stopped mid-write) and is fixed from the admin console.
Check Salesforce for an existing record before using "Create in Salesforce" on a `pending` one.

---

## 5. Build for production (Node adapter)

```bash
npm run build
# Output in ./build/
node build   # starts the production server
```

The `build/` folder is what gets containerized for ECS Fargate.

---

## 6. Type checking

```bash
npm run check         # one-time
npm run check:watch   # watch mode
```

---

## Project structure

```
src/
├── routes/
│   ├── (auth)/        # Login, register — full-screen layout, no sidebar
│   │   ├── login/
│   │   └── register/
│   ├── (app)/         # Protected routes — sidebar + topbar layout
│   │   ├── dashboard/
│   │   ├── accounts/
│   │   ├── stores/
│   │   ├── issues/
│   │   ├── payments/
│   │   └── services/
│   └── auth/          # OAuth handlers (Google callback, logout)
├── lib/
│   ├── components/
│   │   ├── ui/        # Badge, Button, Card, StatCard, Toast
│   │   └── layout/    # Sidebar, Topbar
│   ├── stores/        # auth.ts (Svelte writable stores)
│   └── types/         # Shared TypeScript interfaces
├── app.css            # Global design system (CSS variables, base styles)
├── app.d.ts           # App.Locals type extension
└── hooks.server.ts    # Auth middleware — reads session cookie → locals.user
```

---

## Auth stub (dev mode)

In development, `hooks.server.ts` attaches a mock user whenever the `session` cookie is present. Any non-empty value works. Log in via `/login` with any email/password to set the cookie.

Real auth (argon2 + PostgreSQL sessions) is wired up in `src/routes/(auth)/login/+page.server.ts` — see the `// TODO` comments.

---

## Adding a new route

1. Create `src/routes/(app)/my-feature/+page.svelte`
2. Add it to the `navItems` array in `src/lib/components/layout/Sidebar.svelte`
3. Optionally add `+page.server.ts` for server-side data loading

---

## Linting & formatting

```bash
npm run lint     # eslint + prettier check
npm run format   # prettier write
```
