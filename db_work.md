# DB Work

**Add psql to your PATH** (one-time, so you can just type `psql`):

```bash
echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Daily commands:**

```bash
# Stop / start / status
brew services stop postgresql@16
brew services start postgresql@16
brew services list

# Connect
psql "postgresql://postgres:postgres@localhost:5432/samdoctor"
psql -d samdoctor              # if logged in as superuser
psql -d samdoctor -c '\dt'     # list tables
psql -d samdoctor -c '\d users' # describe a table
```

**Applying future schema changes** — since this isn't Docker, no volume-reset trick. Just add `002_*.sql`, `003_*.sql`, etc. and run:

```bash
psql "postgresql://postgres:postgres@localhost:5432/samdoctor" -f db/migrations/002_whatever.sql
```

The `docker-compose.yml` I created earlier is still there and will work if you ever install Docker — harmless to keep, or delete it if you want a Homebrew-only setup.
