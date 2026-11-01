# ad-saas-web-app

SvelteKit (Node adapter) web app backed by Postgres and Redis, with Salesforce, Stripe and Amazon SP-API integrations. This repo started from an import of the `appeal-dr-app` codebase.

Further docs: `SETUP.md` (developer setup), `docs/` (runbooks), `AWS_DEPLOYMENT_STEPS.md` (deployment).

---

## Repository configuration: step by step

### 1. Connect your local clone to GitHub

```bash
git remote -v                       # should show origin -> github.com/appealsdr/ad-saas-web-app
# if origin is missing:
git remote add origin https://github.com/appealsdr/ad-saas-web-app.git
git fetch origin
git checkout main
git pull origin main
```

In GitHub Desktop: **File → Add Local Repository…** and pick this folder (do not use Clone; the folder is not empty).

### 2. Set your git identity

```bash
git config user.name  "Your Name"
git config user.email "you@example.com"
```

### 3. Never commit secrets

`.gitignore` already excludes `.env*` (except `.env.example`), `keys/*`, `uploads/`, `global-bundle.pem`, `aws setup.md` and other credential files. Before the first commit, run:

```bash
git status --short       # no .env, *.key, *.pem, or credentials should appear
```

Private keys (`server.key`, `server.crt`) must stay out of the repo. Keep them in `keys/` locally, or in your secrets manager. If a secret is ever committed, rotate it. Deleting the file is not enough.

### 4. Install and configure the app

```bash
nvm use 22            # Node 22+, npm 10+
npm install
# create .env with the required variables (get the values from your team or secrets manager)
touch .env
docker compose up -d  # local Postgres 16 + Redis 7
npm run dev           # http://localhost:5173
```

Apply the SQL files in `db/migrations/` in numeric order to your database (`001` through the latest).

### 5. Set up repo protections on GitHub (repo admin)

In **Settings → Branches → Add rule** for `main`:
- Require a pull request before merging (at least 1 approval)
- Require status checks to pass (add CI once it exists)
- Block force pushes and branch deletion

Also under **Settings → Code security**: enable secret scanning, push protection and Dependabot alerts.

### 6. Add collaborators and CI secrets

- **Settings → Collaborators and teams**: grant access to the people and teams who need it.
- **Settings → Secrets and variables → Actions**: add environment secrets (database URL, Stripe, Salesforce, AWS) for CI/CD. Never put them in the repo.

### 7. Daily workflow

```bash
git checkout -b feature/<short-name>
# make changes
npm run check && npm run lint && npm test
git commit -am "Describe the change"
git push -u origin feature/<short-name>
# open a Pull Request into main
```

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build into `./build` |
| `npm run preview` | Preview the production build |
| `npm run check` | Svelte and TypeScript checks |
| `npm run lint` | Prettier and ESLint |
| `npm test` | Vitest unit tests |
| `npm run admin:cli` | Platform admin CLI (reads `.env`) |
