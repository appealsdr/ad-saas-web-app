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
