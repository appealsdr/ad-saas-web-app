#!/usr/bin/env python3
"""
End-to-end smoke test for the public API (/api/v1) — one integration, one store.

Standard library only (Python 3.8+). Read-only by default; anything that creates or
changes data needs --write. See docs/api-v1-testing.md for the full guide.

Examples
  # Safe, read-only check of a store (auth, list/read stores, cases, messages, required files, tenancy)
  python3 scripts/api_v1_smoke_test.py --base-url https://staging.example.com --key adi_xxx --store-id <uuid>

  # Full run, including creates/uploads (writes real records marked "[API TEST]")
  python3 scripts/api_v1_smoke_test.py --base-url ... --key adi_xxx --store-id <uuid> --write

  # Also verify a restricted integration is blocked correctly
  python3 scripts/api_v1_smoke_test.py ... --limited-key adi_yyy --limited-allows stores.list,cases.list

Environment fallbacks: API_BASE_URL, API_KEY, API_STORE_ID, API_LIMITED_KEY.
Exit code 0 = no failures, 1 = at least one FAIL.
"""
import argparse, json, os, re, sys, time, uuid
import urllib.error, urllib.parse, urllib.request

PERMS = ['stores.list', 'stores.read', 'stores.create', 'stores.update', 'cases.list', 'cases.read',
         'cases.create', 'messages.list', 'messages.create', 'files.requirements.read', 'files.upload']

# Smallest valid one-page PDF, used as the upload sample.
MINI_PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
            b"trailer<</Root 1 0 R/Size 4>>\n%%EOF\n")

results = {'PASS': 0, 'FAIL': 0, 'SKIP': 0}


def report(status, name, detail=''):
    results[status] += 1
    mark = {'PASS': '\033[32mPASS\033[0m', 'FAIL': '\033[31mFAIL\033[0m', 'SKIP': '\033[33mSKIP\033[0m'}[status]
    print(f'  [{mark}] {name}' + (f'  — {detail}' if detail else ''))


class Resp:
    def __init__(self, status, headers, raw):
        self.status, self.headers, self.raw = status, {k.lower(): v for k, v in headers.items()}, raw
        try:
            self.json = json.loads(raw.decode() or 'null')
        except Exception:
            self.json = None

    @property
    def code(self):
        return (self.json or {}).get('error', {}).get('code') if isinstance(self.json, dict) else None


def call(base, method, path, key=None, body=None, headers=None, raw_body=None, timeout=60):
    h = {'accept': 'application/json'}
    if key is not None:
        h['authorization'] = f'Bearer {key}'
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h['content-type'] = 'application/json'
    if raw_body is not None:
        data = raw_body
    h.update(headers or {})
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return Resp(r.status, dict(r.headers), r.read())
    except urllib.error.HTTPError as e:
        return Resp(e.code, dict(e.headers), e.read())


def expect(name, resp, status, code=None):
    ok = resp.status == status and (code is None or resp.code == code)
    want = f'{status}' + (f' {code}' if code else '')
    got = f'{resp.status}' + (f' {resp.code}' if resp.code else '')
    report('PASS' if ok else 'FAIL', name, '' if ok else f'expected {want}, got {got}: {resp.raw[:200].decode(errors="replace")}')
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--base-url', default=os.environ.get('API_BASE_URL'))
    ap.add_argument('--key', default=os.environ.get('API_KEY'), help='Integration credential (adi_…)')
    ap.add_argument('--store-id', default=os.environ.get('API_STORE_ID'), help='Store UUID to test against')
    ap.add_argument('--case-id', help='Existing case id to use (otherwise first case of the store, or a new one with --write)')
    ap.add_argument('--slot-id', help='Required-file slot id to upload into (default: first slot of the case)')
    ap.add_argument('--file', help='File to upload instead of the built-in sample PDF')
    ap.add_argument('--mime', help='MIME type for --file (default guessed from extension)')
    ap.add_argument('--write', action='store_true', help='Also run tests that create/modify data')
    ap.add_argument('--create-store', action='store_true', help='With --write: also create a brand-new store (POST /stores)')
    ap.add_argument('--big-test', action='store_true', help='Upload a 26 MB file to verify the 25 MB limit (slow)')
    ap.add_argument('--rate-test', type=int, metavar='N', help='Send up to N quick requests and expect a 429 (use N above the integration limit)')
    ap.add_argument('--limited-key', default=os.environ.get('API_LIMITED_KEY'), help='Credential of a restricted integration to verify 403s')
    ap.add_argument('--limited-allows', default='', help='Comma-separated permissions the limited integration HAS')
    a = ap.parse_args()
    if not (a.base_url and a.key):
        ap.error('--base-url and --key are required (or API_BASE_URL / API_KEY)')
    base, key = a.base_url.rstrip('/'), a.key
    run_id = time.strftime('%Y%m%d-%H%M%S')
    ctx = {'store': a.store_id, 'case': a.case_id, 'slot': a.slot_id}

    print(f'\nAPI v1 smoke test → {base}   run {run_id}   writes={"ON" if a.write else "off"}\n')

    # ── 1. Authentication ─────────────────────────────────────────────
    print('1. Authentication')
    expect('no credential → 401', call(base, 'GET', '/api/v1/stores'), 401, 'INVALID_CREDENTIAL')
    expect('invalid credential → 401', call(base, 'GET', '/api/v1/stores', key='adi_not_a_real_key'), 401, 'INVALID_CREDENTIAL')
    r = call(base, 'GET', '/api/v1/stores', key=key)
    if not expect('valid credential lists stores (stores.list)', r, 200):
        print('\nCannot continue: the credential was rejected or lacks stores.list.'); return finish()
    report('PASS' if r.headers.get('x-request-id') else 'FAIL', 'response carries x-request-id')
    stores = (r.json or {}).get('data', [])
    report('PASS' if isinstance(stores, list) and 'paging' in (r.json or {}) else 'FAIL', f'list shape ok ({len(stores)} store(s))')

    # ── 2. Stores ─────────────────────────────────────────────────────
    print('\n2. Stores')
    if not ctx['store'] and stores:
        ctx['store'] = stores[0]['id']; print(f'  (using first store {ctx["store"]})')
    if not ctx['store']:
        report('SKIP', 'no store available — pass --store-id or use --write --create-store')
    if a.write and a.create_store:
        r = call(base, 'POST', '/api/v1/stores', key, {'name': f'[API TEST] Store {run_id}', 'country': 'US'},
                 {'Idempotency-Key': f'store-{run_id}'})
        if expect('create store (stores.create)', r, 201):
            ctx['store'] = r.json['data']['id']
            print(f'  (new store {ctx["store"]}, salesforceSynced={r.json.get("salesforceSynced")})')
        expect('create store without name → 422', call(base, 'POST', '/api/v1/stores', key, {'country': 'US'}), 422, 'VALIDATION_ERROR')
        expect('create store with bad email → 422', call(base, 'POST', '/api/v1/stores', key, {'name': 'x', 'storeEmail': 'nope'}), 422, 'VALIDATION_ERROR')
    s = ctx['store']
    if s:
        r = call(base, 'GET', f'/api/v1/stores/{s}', key)
        if expect('read store (stores.read)', r, 200):
            missing = [k for k in ('id', 'name', 'marketplaces', 'amazonConnection', 'createdAt') if k not in r.json['data']]
            report('FAIL' if missing else 'PASS', 'store has expected fields', f'missing {missing}' if missing else '')
        if a.write:
            r = call(base, 'PATCH', f'/api/v1/stores/{s}', key, {'description': f'API smoke test {run_id}'})
            expect('update store (stores.update)', r, 200)
            expect('update store with no fields → 422', call(base, 'PATCH', f'/api/v1/stores/{s}', key, {}), 422, 'VALIDATION_ERROR')
        else:
            report('SKIP', 'update/create store (needs --write)')

    # ── 3. Tenancy / not-found ────────────────────────────────────────
    print('\n3. Tenancy & not-found (another account looks identical to "does not exist")')
    ghost = str(uuid.uuid4())
    expect('unknown store uuid → 404', call(base, 'GET', f'/api/v1/stores/{ghost}', key), 404, 'NOT_FOUND')
    expect('malformed store id → 404', call(base, 'GET', '/api/v1/stores/not-a-uuid', key), 404, 'NOT_FOUND')
    expect('cases of unknown store → 404', call(base, 'GET', f'/api/v1/stores/{ghost}/cases', key), 404, 'NOT_FOUND')
    if s:
        expect('unknown case id → 404', call(base, 'GET', f'/api/v1/stores/{s}/cases/500000000000000AAA', key), 404, 'NOT_FOUND')
        expect('integrationId in query string is ignored', call(base, 'GET', f'/api/v1/stores?integrationId={ghost}', key), 200)

    # ── 4. Cases ──────────────────────────────────────────────────────
    print('\n4. Cases')
    if s:
        r = call(base, 'GET', f'/api/v1/stores/{s}/cases', key)
        if expect('list cases (cases.list)', r, 200):
            cases = r.json['data']
            report('PASS' if 'total' in r.json['paging'] else 'FAIL', f'{len(cases)} case(s) returned, paging ok')
            if not ctx['case'] and cases:
                ctx['case'] = cases[0]['id']
        if a.write:
            body = {'subject': f'[API TEST] case {run_id}', 'description': '<b>Created by the API smoke test</b>', 'priority': 'Low'}
            r = call(base, 'POST', f'/api/v1/stores/{s}/cases', key, body, {'Idempotency-Key': f'case-{run_id}'})
            if expect('create case (cases.create)', r, 201):
                ctx['case'] = ctx['case'] if a.case_id else r.json['data']['id']
                print(f'  (case {r.json["data"]["id"]})')
                r2 = call(base, 'POST', f'/api/v1/stores/{s}/cases', key, body, {'Idempotency-Key': f'case-{run_id}'})
                ok = r2.status == 201 and r2.json['data']['id'] == r.json['data']['id'] and r2.headers.get('idempotent-replayed') == 'true'
                report('PASS' if ok else 'FAIL', 'same Idempotency-Key replays the same case (no duplicate)')
                expect('same key, different body → 422', call(base, 'POST', f'/api/v1/stores/{s}/cases', key, {**body, 'subject': 'other'}, {'Idempotency-Key': f'case-{run_id}'}), 422, 'IDEMPOTENCY_KEY_REUSED')
            expect('create case without subject → 422', call(base, 'POST', f'/api/v1/stores/{s}/cases', key, {'priority': 'Low'}), 422, 'VALIDATION_ERROR')
            expect('create case with bad priority → 422', call(base, 'POST', f'/api/v1/stores/{s}/cases', key, {'subject': 'x', 'priority': 'Urgent'}), 422, 'VALIDATION_ERROR')
        else:
            report('SKIP', 'create case (needs --write)')
        if ctx['case']:
            r = call(base, 'GET', f'/api/v1/stores/{s}/cases/{ctx["case"]}', key)
            if expect('read case (cases.read)', r, 200):
                report('PASS' if r.json['data'].get('id') == ctx['case'] else 'FAIL', 'returned case matches requested id')
        else:
            report('SKIP', 'read case — store has no cases (use --case-id or --write)')

    # ── 5. Messages ───────────────────────────────────────────────────
    print('\n5. Messages')
    s, c = ctx['store'], ctx['case']
    if s and c:
        base_p = f'/api/v1/stores/{s}/cases/{c}/messages'
        r = call(base, 'GET', base_p, key)
        if expect('list messages (messages.list)', r, 200):
            report('PASS' if isinstance(r.json['data'], list) else 'FAIL', f'{len(r.json["data"])} message(s)')
        if a.write:
            m = {'body': f'<p>API smoke test message {run_id} <script>alert(1)</script></p>'}
            r = call(base, 'POST', base_p, key, m, {'Idempotency-Key': f'msg-{run_id}'})
            if expect('create message (messages.create)', r, 201):
                r2 = call(base, 'POST', base_p, key, m, {'Idempotency-Key': f'msg-{run_id}'})
                report('PASS' if r2.status == 201 and r2.json['data']['id'] == r.json['data']['id'] else 'FAIL', 'message replay is idempotent')
                lst = call(base, 'GET', base_p, key).json['data']
                mine = [x for x in lst if x['id'] == r.json['data']['id']]
                report('PASS' if mine and '<script' not in mine[0]['body'] else 'FAIL', 'posted message visible and <script> stripped')
            expect('empty message → 422', call(base, 'POST', base_p, key, {'body': '   '}), 422)
        else:
            report('SKIP', 'create message (needs --write)')
    else:
        report('SKIP', 'messages — no case available')

    # ── 6. Required files & uploads ───────────────────────────────────
    print('\n6. Required files & uploads')
    if s and c:
        rf = f'/api/v1/stores/{s}/cases/{c}/required-files'
        r = call(base, 'GET', rf, key)
        slots = r.json['data'] if expect('list required files (files.requirements.read)', r, 200) else []
        for sl in slots[:3]:
            print(f'    slot {sl["id"]}: "{sl["name"]}" accepts {sl["acceptedFormats"] or "any"}, uploaded={sl["uploaded"]}')
        slot = next((x for x in slots if x['id'] == ctx['slot']), None) if ctx['slot'] else (slots[0] if slots else None)
        if a.write and slot:
            up = f'{rf}/{slot["id"]}/uploads'
            fmts = slot['acceptedFormats']
            if a.file:
                data, name = open(a.file, 'rb').read(), os.path.basename(a.file)
                import mimetypes; mime = a.mime or mimetypes.guess_type(name)[0] or 'application/octet-stream'
            else:
                data, name, mime = MINI_PDF, f'api-test-{run_id}.pdf', 'application/pdf'
            r = call(base, 'POST', up, key, raw_body=data, headers={'Content-Type': mime, 'X-File-Name': name, 'Idempotency-Key': f'up-{run_id}'})
            if expect(f'upload {name} ({mime}, {len(data)} bytes) (files.upload)', r, 201):
                d = r.json['data']
                report('PASS' if d['sizeBytes'] == len(data) and d['fileName'] == name else 'FAIL', 'response reports the stored name and size')
                r2 = call(base, 'POST', up, key, raw_body=data, headers={'Content-Type': mime, 'X-File-Name': name, 'Idempotency-Key': f'up-{run_id}'})
                report('PASS' if r2.status == 201 and r2.json['data']['id'] == d['id'] else 'FAIL', 'upload replay is idempotent (one file stored)')
                again = [x for x in call(base, 'GET', rf, key).json['data'] if x['id'] == slot['id']]
                report('PASS' if again and again[0]['uploaded'] else 'FAIL', 'slot now reports uploaded=true')
            expect('unsupported type (application/x-msdownload) → 415', call(base, 'POST', up, key, raw_body=b'MZ', headers={'Content-Type': 'application/x-msdownload', 'X-File-Name': 'a.exe'}), 415, 'UNSUPPORTED_MEDIA_TYPE')
            expect('missing X-File-Name → 422', call(base, 'POST', up, key, raw_body=MINI_PDF, headers={'Content-Type': 'application/pdf'}), 422, 'VALIDATION_ERROR')
            expect('empty body → 422', call(base, 'POST', up, key, raw_body=b'', headers={'Content-Type': 'application/pdf', 'X-File-Name': 'e.pdf'}), 422, 'VALIDATION_ERROR')
            if fmts and 'exe' not in fmts and 'png' not in fmts:
                expect(f'extension not accepted by slot ({fmts}) → 422', call(base, 'POST', up, key, raw_body=b'\x89PNG\r\n', headers={'Content-Type': 'image/png', 'X-File-Name': 'x.png'}), 422, 'VALIDATION_ERROR')
            expect('unknown slot id → 404', call(base, 'POST', f'{rf}/a0YAAAAAAAAAAAAAAA/uploads', key, raw_body=MINI_PDF, headers={'Content-Type': 'application/pdf', 'X-File-Name': 'x.pdf'}), 404, 'NOT_FOUND')
            if a.big_test:
                big = b'0' * (26 * 1024 * 1024)
                expect('26 MB file → 413 (limit is 25 MB)', call(base, 'POST', up, key, raw_body=big, headers={'Content-Type': 'application/pdf', 'X-File-Name': 'big.pdf'}, timeout=300), 413, 'PAYLOAD_TOO_LARGE')
            else:
                report('SKIP', '25 MB limit (add --big-test)')
        else:
            report('SKIP', 'upload tests (needs --write and a slot on the case)')
    else:
        report('SKIP', 'required files — no case available')

    # ── 7. Permission matrix for a restricted key ─────────────────────
    print('\n7. Permission enforcement (restricted integration)')
    if a.limited_key and s:
        allows = {p for p in a.limited_allows.split(',') if p}
        bad = allows - set(PERMS)
        if bad: print(f'  unknown permission(s) in --limited-allows: {sorted(bad)}'); results['FAIL'] += 1
        cc = c or '500000000000000AAA'; sl = ctx['slot'] or 'a0YAAAAAAAAAAAAAAA'
        probes = [('stores.list', 'GET', '/api/v1/stores', None), ('stores.read', 'GET', f'/api/v1/stores/{s}', None),
                  ('stores.create', 'POST', '/api/v1/stores', {}), ('stores.update', 'PATCH', f'/api/v1/stores/{s}', {}),
                  ('cases.list', 'GET', f'/api/v1/stores/{s}/cases', None), ('cases.read', 'GET', f'/api/v1/stores/{s}/cases/{cc}', None),
                  ('cases.create', 'POST', f'/api/v1/stores/{s}/cases', {}), ('messages.list', 'GET', f'/api/v1/stores/{s}/cases/{cc}/messages', None),
                  ('messages.create', 'POST', f'/api/v1/stores/{s}/cases/{cc}/messages', {}),
                  ('files.requirements.read', 'GET', f'/api/v1/stores/{s}/cases/{cc}/required-files', None),
                  ('files.upload', 'POST', f'/api/v1/stores/{s}/cases/{cc}/required-files/{sl}/uploads', None)]
        for perm, method, path, body in probes:
            hdr = {'Content-Type': 'application/pdf', 'X-File-Name': 'x.pdf'} if perm == 'files.upload' else None
            r = call(base, method, path, a.limited_key, body, hdr, raw_body=b'%PDF' if perm == 'files.upload' else None)
            denied = r.status == 403 and r.code == 'PERMISSION_DENIED'
            if perm in allows:
                report('FAIL' if denied else 'PASS', f'{perm}: allowed (got {r.status}{" " + r.code if r.code else ""})', 'wrongly denied' if denied else '')
            else:
                report('PASS' if denied else 'FAIL', f'{perm}: denied → 403 PERMISSION_DENIED', '' if denied else f'got {r.status} {r.code}')
    else:
        report('SKIP', 'needs --limited-key (and --limited-allows)')

    # ── 8. Rate limit ─────────────────────────────────────────────────
    print('\n8. Rate limit')
    if a.rate_test:
        hit = None
        for i in range(a.rate_test):
            r = call(base, 'GET', '/api/v1/stores?limit=1', key)
            if r.status == 429:
                hit = (i + 1, r); break
        if hit:
            report('PASS' if hit[1].headers.get('retry-after') else 'FAIL', f'429 RATE_LIMITED after {hit[0]} requests, Retry-After={hit[1].headers.get("retry-after")}')
        else:
            report('FAIL', f'no 429 after {a.rate_test} requests — is the limit higher than N?')
    else:
        report('SKIP', 'add --rate-test N (N above the integration’s per-minute limit); wait a minute afterwards')
    return finish()


def finish():
    print(f'\nResult: {results["PASS"]} passed, {results["FAIL"]} failed, {results["SKIP"]} skipped')
    return 1 if results['FAIL'] else 0


if __name__ == '__main__':
    sys.exit(main())
