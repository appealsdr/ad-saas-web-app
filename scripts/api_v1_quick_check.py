#!/usr/bin/env python3
"""
Quick, READ-ONLY health check of the public API — safe for staging AND production.
Never creates, changes or uploads anything (use api_v1_smoke_test.py --write for that, on staging only).
Standard library only (Python 3.8+).

Configure each environment once via variables (or pass flags):
  STAGING_API_URL  STAGING_API_KEY  [STAGING_STORE_ID]
  PROD_API_URL     PROD_API_KEY     [PROD_STORE_ID]

  python3 scripts/api_v1_quick_check.py --env staging
  python3 scripts/api_v1_quick_check.py --env production
  python3 scripts/api_v1_quick_check.py --env both        # runs staging then production
  python3 scripts/api_v1_quick_check.py --url https://host --key adi_… [--store-id UUID]

Checks (about 8 requests): bad/missing key rejected, stores list, store read, unknown id → 404,
cases list, first case read, messages list, required files list. Exit code 1 on any failure.
"""
import argparse, json, os, sys, urllib.error, urllib.request, uuid

ENVS = {'staging': 'STAGING', 'production': 'PROD'}


def call(base, path, key=None):
    h = {'accept': 'application/json'}
    if key is not None:
        h['authorization'] = f'Bearer {key}'
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, headers=h), timeout=30) as r:
            return r.status, json.loads(r.read().decode() or 'null')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or 'null')
        except Exception:
            return e.code, None
    except Exception as e:  # network/DNS/TLS
        return 0, {'error': {'code': 'NETWORK', 'message': str(e)}}


def code(body):
    return ((body or {}).get('error') or {}).get('code') if isinstance(body, dict) else None


def run(label, base, key, store_id):
    base = base.rstrip('/')
    fails = 0
    print(f'\n== {label}: {base} ==')

    def check(name, ok, detail=''):
        nonlocal fails
        fails += 0 if ok else 1
        print(f'  [{"PASS" if ok else "FAIL"}] {name}' + (f' — {detail}' if detail and not ok else ''))
        return ok

    s, b = call(base, '/api/v1/stores')
    check('no key → 401', s == 401 and code(b) == 'INVALID_CREDENTIAL', f'{s} {code(b)}')
    s, b = call(base, '/api/v1/stores', 'adi_invalid_key')
    check('bad key → 401', s == 401 and code(b) == 'INVALID_CREDENTIAL', f'{s} {code(b)}')

    s, b = call(base, '/api/v1/stores?limit=100', key)
    if not check('key accepted, stores listed', s == 200 and isinstance(b.get('data'), list), f'{s} {code(b)} {(b or {}).get("error", {}).get("message", "")}'):
        return fails + 1  # nothing else can work
    stores = b['data']
    print(f'         {len(stores)} store(s) visible to this integration')
    sid = store_id or (stores[0]['id'] if stores else None)
    if not sid:
        print('  [SKIP] no store to test further (pass --store-id)')
        return fails

    s, b = call(base, f'/api/v1/stores/{sid}', key)
    check('store read', s == 200 and b['data']['id'] == sid, f'{s} {code(b)}')
    s, b = call(base, f'/api/v1/stores/{uuid.uuid4()}', key)
    check('unknown store → 404', s == 404 and code(b) == 'NOT_FOUND', f'{s} {code(b)}')

    s, b = call(base, f'/api/v1/stores/{sid}/cases?limit=1', key)
    if check('cases list', s == 200 and 'paging' in b, f'{s} {code(b)}') and b['data']:
        cid = b['data'][0]['id']
        s, b = call(base, f'/api/v1/stores/{sid}/cases/{cid}', key)
        check('case read', s == 200 and b['data']['id'] == cid, f'{s} {code(b)}')
        s, b = call(base, f'/api/v1/stores/{sid}/cases/{cid}/messages', key)
        check('messages list', s == 200 and isinstance(b['data'], list), f'{s} {code(b)}')
        s, b = call(base, f'/api/v1/stores/{sid}/cases/{cid}/required-files', key)
        check('required files list', s == 200 and isinstance(b['data'], list), f'{s} {code(b)}')
    else:
        print('  [SKIP] store has no cases — case/messages/required-files not checked')
    return fails


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--env', choices=['staging', 'production', 'both'])
    ap.add_argument('--url'); ap.add_argument('--key'); ap.add_argument('--store-id')
    a = ap.parse_args()
    jobs = []
    if a.url or a.key:
        if not (a.url and a.key):
            ap.error('--url and --key go together')
        jobs.append(('custom', a.url, a.key, a.store_id))
    elif a.env:
        for name in (['staging', 'production'] if a.env == 'both' else [a.env]):
            p = ENVS[name]
            url, key = os.environ.get(f'{p}_API_URL'), os.environ.get(f'{p}_API_KEY')
            if not (url and key):
                ap.error(f'set {p}_API_URL and {p}_API_KEY (or use --url/--key)')
            jobs.append((name, url, key, a.store_id or os.environ.get(f'{p}_STORE_ID')))
    else:
        ap.error('choose --env staging|production|both, or --url and --key')
    total = sum(run(*j) for j in jobs)
    print('\n' + ('All checks passed.' if not total else f'{total} check(s) FAILED.'))
    return 1 if total else 0


if __name__ == '__main__':
    sys.exit(main())
