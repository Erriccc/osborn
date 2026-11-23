#!/usr/bin/env python3
"""
Osborn Fly cross-org migration — generalized, env-driven tool (agent-driven; no UI).

Give it the two org keys via env and run subcommands. Proven in the 2026-11-23
audos->kelechi move; this is that logic parameterized into one deduped module.

ENV (the keys an operator/agent provides):
  SRC_FLY_TOKEN   source org Fly token (reads/exec/autostart work even if the source is frozen)
  DST_FLY_TOKEN   dest org Fly token   (apps via `fly apps create <name>` with NO --org)
  SUPABASE_URL    NEXT_PUBLIC_SUPABASE_URL           (audit + cutover only)
  SUPABASE_KEY    SUPABASE_SERVICE_ROLE_KEY          (bypasses RLS; audit + cutover only)
optional:
  DST_SANDBOX_APP=osborn-sandbox4   DST_SUFFIX=-k   FRONTEND_DIR=./frontend
  RAILWAY_SERVICE=frontend          STAGE_DIR=/tmp/osborn-migrate

SUBCOMMANDS:
  list                      enumerate source sprite/pool apps to migrate
  image <ver>               build+push dest sandbox image, retag :latest
  infra <src-app>           create dest app+IP+volume(s)+machine(s) (config+secrets copied)
  data <src-app>            machine-to-machine data pull (~/.claude, wipe-safe)
  roll <ver> [app...]       config-update dest machines to a sandbox image version
  audit                     print the live pointer surface (Supabase + Railway)
  cutover-plan              dry-run the DB pointer flip (no writes)
  cutover-commit            flip Supabase instances/machine_pool keyed by user_id (wipe-proof)

Dest naming: strip a trailing '-n', append DST_SUFFIX; pool apps get a fresh
osborn-pool-<12hex> name. Cutover ordering (Railway-first, deploy-live, wipe-proof) is
the operator's responsibility — see the skill SKILL.md; this tool does the DB half.
"""
import os, sys, json, time, subprocess, urllib.request, urllib.error, re, uuid

MACH = 'https://api.machines.dev/v1'
os.environ.setdefault('FLY_NO_UPDATE_CHECK', '1'); os.environ.setdefault('FLYCTL_NO_UPDATE_CHECK', '1')

def env(k, d=None, req=False):
    v = os.environ.get(k, d)
    if req and not v: sys.exit(f'missing required env {k}')
    return v

SRC = env('SRC_FLY_TOKEN'); DST = env('DST_FLY_TOKEN')
SB_URL = env('SUPABASE_URL'); SB_KEY = env('SUPABASE_KEY')
DST_SANDBOX_APP = env('DST_SANDBOX_APP', 'osborn-sandbox4')
DST_SUFFIX = env('DST_SUFFIX', '-k')
FRONTEND_DIR = env('FRONTEND_DIR', './frontend')
RAILWAY_SERVICE = env('RAILWAY_SERVICE', 'frontend')
STAGE = env('STAGE_DIR', '/tmp/osborn-migrate')
EXCLUDE_APPS = re.compile(r'(^fly-builder-|sandbox|voice-e2e|browser-spike|-pool-)')
NAMEMAP = f'{STAGE}/namemap.txt'  # src->dst recorded by `infra`; cutover resolves through it

def nm_add(s, d):
    os.makedirs(STAGE, exist_ok=True); open(NAMEMAP, 'a').write(f'{s} {d}\n')
def nm_load():
    try: return dict(l.split() for l in open(NAMEMAP) if len(l.split()) == 2)
    except Exception: return {}
def resolve(old, nm):
    """src app name -> dst. namemap wins (required for fresh pool names); sprites fall
    back to the deterministic transform, which is idempotent so re-runs don't -k-k."""
    if old in nm: return nm[old]
    if '-pool-' in old: return None  # pools must be in the namemap
    if old.endswith(DST_SUFFIX): return old
    return re.sub(r'-n$', '', old) + DST_SUFFIX

# ---- HTTP helpers (single copy each) ----
def _http(method, url, headers, body=None, timeout=60):
    data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(); return r.status, (json.loads(raw) if raw and raw[:1] in b'[{' else raw)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw[:300].decode('utf8', 'replace')

def fly_api(method, path, token, body=None, timeout=60):
    return _http(method, MACH + path, {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, body, timeout)

def sb(method, path, body=None):
    if not (SB_URL and SB_KEY): sys.exit('SUPABASE_URL/SUPABASE_KEY required for this command')
    h = {'apikey': SB_KEY, 'Authorization': f'Bearer {SB_KEY}', 'Accept-Profile': 'public',
         'Content-Profile': 'public', 'Content-Type': 'application/json'}
    return _http(method, f'{SB_URL}/rest/v1/{path}', h, body)

def flycli(args, token):
    p = subprocess.run(['fly', *args], capture_output=True, text=True, env=dict(os.environ, FLY_API_TOKEN=token))
    return p.returncode, '\n'.join(l for l in (p.stdout + p.stderr).splitlines() if 'Metrics' not in l and 'update check' not in l)

# ---- domain helpers ----
def machines(app, token):
    st, d = fly_api('GET', f'/apps/{app}/machines', token); return d if isinstance(d, list) else []

def ws_machine(ms):  # prefer the /workspace-mounted machine
    for m in ms:
        if any(mt.get('path') == '/workspace' for mt in m['config'].get('mounts', [])): return m
    return ms[0] if ms else None

def wake(app, token, timeout=180):
    subprocess.run(['curl', '-s', '-o', '/dev/null', '-m', '10', f'https://{app}.fly.dev/sessions/manifest'], capture_output=True)
    ms = machines(app, token)
    if not ms: return False
    mid = ms[0]['id']
    for _ in range(timeout // 5):
        st, d = fly_api('GET', f'/apps/{app}/machines/{mid}', token)
        if isinstance(d, dict) and d.get('state') == 'started': return True
        time.sleep(5)
    return False

def execm(app, token, cmd, timeout=120):
    m = ws_machine(machines(app, token))
    if not m: return '', 'no machine', 1
    st, d = fly_api('POST', f'/apps/{app}/machines/{m["id"]}/exec', token, {'command': ['sh', '-c', cmd], 'timeout': timeout}, timeout + 30)
    if isinstance(d, dict): return d.get('stdout', ''), d.get('stderr', ''), d.get('exit_code')
    return '', str(d), 1

def src_token(app, ms):
    for m in ms:
        t = m['config'].get('env', {}).get('OSBORN_SYNC_TOKEN')
        if t: return t
    out, _, _ = execm(app, SRC, 'printenv OSBORN_SYNC_TOKEN', 30)
    return out.strip() or None

# ---- subcommands ----
def cmd_list(_):
    rc, out = flycli(['apps', 'list'], SRC)
    apps = [l.split()[0] for l in out.splitlines() if l.strip().startswith('osborn-') and not EXCLUDE_APPS.search(l.split()[0])]
    pools = [l.split()[0] for l in out.splitlines() if '-pool-' in l.split()[0]]
    print('sprites:', ' '.join(apps)); print('pools:  ', ' '.join(pools))

def cmd_image(a):
    ver = a[0] if a else subprocess.run(['curl', '-s', 'https://registry.npmjs.org/osborn'], capture_output=True, text=True).stdout
    if not a:
        ver = json.loads(ver)['dist-tags']['latest']
    flycli(['apps', 'create', DST_SANDBOX_APP], DST)
    rc, out = flycli(['deploy', '--build-only', '--push', '--remote-only', '--image-label', ver,
                      '--build-arg', f'OSBORN_VERSION={ver}', '--app', DST_SANDBOX_APP,
                      '--config', f'{FRONTEND_DIR}/fly-sandbox.toml'], DST)
    print(out[-800:]); print(f'image rc={rc} -> registry.fly.io/{DST_SANDBOX_APP}:{ver}')

def cmd_infra(a):
    src = a[0]; dst = resolve(src, nm_load()) or ('osborn-pool-' + uuid.uuid4().hex[:12]); ver = a[1] if len(a) > 1 else 'latest'
    img = f'registry.fly.io/{DST_SANDBOX_APP}:{ver}'
    ms = machines(src, SRC)
    if not ms: sys.exit(f'no source machines for {src}')
    if 'osborn-sandbox' not in ms[0]['config'].get('image', ''):
        sys.exit(f'{src} runs a non-sandbox image — migrate separately')
    nm_add(src, dst)  # record for cutover (esp. fresh pool names)
    print(f'{src} -> {dst}  ({img})')
    flycli(['apps', 'create', dst], DST)
    flycli(['ips', 'allocate-v4', '--shared', '-a', dst], DST); flycli(['ips', 'allocate-v6', '-a', dst], DST)
    _, svols = fly_api('GET', f'/apps/{src}/volumes', SRC)
    byid = {v['id']: v for v in svols} if isinstance(svols, list) else {}
    for m in ms:
        cfg = json.loads(json.dumps(m['config'])); region = m.get('region', 'iad'); mounts = cfg.get('mounts', [])
        newvol = None
        if mounts:
            size = byid.get(mounts[0].get('volume', ''), {}).get('size_gb', 20)
            st, v = fly_api('POST', f'/apps/{dst}/volumes', DST, {'name': mounts[0].get('name', 'workspace'), 'size_gb': size, 'region': region, 'encrypted': True})
            newvol = v.get('id') if isinstance(v, dict) else None
            for mt in cfg['mounts']: mt['volume'] = newvol
        cfg['image'] = img
        e = cfg.get('env', {})
        for k in ('HOME', 'OSBORN_CWD', 'DEV_APP_NAME', 'DEV_DOMAIN'): e.pop(k, None)
        if 'FLY_API_TOKEN' in e: e['FLY_API_TOKEN'] = DST
        st, res = fly_api('POST', f'/apps/{dst}/machines', DST, {'region': region, 'config': cfg})
        print(f'  machine {m["id"]} -> {res.get("id") if isinstance(res,dict) else res}  vol={newvol}')

def cmd_data(a):
    src = a[0]; dst = resolve(src, nm_load())
    if not dst: print(f'{src}: not in namemap (run `infra` first) — skip'); return
    if not wake(src, SRC): sys.exit('source did not wake')
    tok = src_token(src, machines(src, SRC))
    if not tok: print(f'{src}: no reachable sync token — skip (self-heals)'); return
    if not wake(dst, DST): sys.exit('dest did not wake')
    dmid = ws_machine(machines(dst, DST))['id']
    execm(dst, DST, f'printf %s {tok} > /tmp/srctok; rm -f /tmp/m2m.done', 30)
    pull = (f"nohup sh -c 'T=$(cat /tmp/srctok); mkdir -p /workspace/.claude && "
            f'curl -s -m 1200 -H \"Authorization: Bearer $T\" https://{src}.fly.dev/sessions/export -o /workspace/_exp.tgz '
            f"&& tar xzf /workspace/_exp.tgz -C /workspace/.claude && rm -f /workspace/_exp.tgz "
            f"&& echo OK > /tmp/m2m.done || echo FAIL > /tmp/m2m.done' >/dev/null 2>&1 & echo LAUNCHED")
    execm(dst, DST, pull, 30); print(f'{src} -> {dst}: pull launched; polling…')
    for i in range(180):
        o, _, _ = execm(dst, DST, 'cat /tmp/m2m.done 2>/dev/null', 20)
        if o.strip() in ('OK', 'FAIL'): print('  result:', o.strip()); break
        time.sleep(10)
    def count(app, tok2): return execm(app, tok2, "find /workspace/.claude/projects -name '*.jsonl' 2>/dev/null|wc -l; du -sh /workspace/.claude 2>/dev/null|cut -f1", 40)[0].strip().replace('\n', ' ')
    print('  VERIFY source:', count(src, SRC), ' dest:', count(dst, DST))
    # /sessions/export does NOT carry the Claude login or config — without these the dest
    # agent can't auth to Claude and falls back to a non-Claude model. Copy the small files.
    copied = []
    for f in ('/workspace/.claude/.credentials.json', '/workspace/.claude.json', '/workspace/.claude/.config.json'):
        b64, _, _ = execm(src, SRC, f'base64 -w0 {f} 2>/dev/null', 30)
        if not b64.strip(): continue
        execm(dst, DST, f"mkdir -p {f.rsplit('/',1)[0]}; printf %s '{b64.strip()}' | base64 -d > {f} && chmod 600 {f}", 30)
        copied.append(f.split('/')[-1])
    print(f'  Claude auth/config copied: {copied or "none on source"}')

def cmd_roll(a):
    ver = a[0]; targets = a[1:]
    img = f'registry.fly.io/{DST_SANDBOX_APP}:{ver}'
    if not targets:
        rc, out = flycli(['apps', 'list'], DST)
        targets = [l.split()[0] for l in out.splitlines() if l.split() and l.split()[0].endswith(DST_SUFFIX) or '-pool-' in (l.split() or [''])[0]]
    for app in targets:
        for m in machines(app, DST):
            cfg = m['config']
            if ver in cfg.get('image', ''): print(f'  {app}: already {ver}'); continue
            cfg['image'] = img
            st, d = fly_api('POST', f'/apps/{app}/machines/{m["id"]}', DST, {'config': cfg, 'skip_launch': True})
            print(f'  {app}: -> {ver} [{d.get("state") if isinstance(d,dict) else d}]')

def cmd_audit(_):
    _, inst = sb('GET', 'instances?select=user_id,sandbox_id,server_url,sandbox_url')
    _, pool = sb('GET', 'machine_pool?select=id,app_name')
    print('Supabase instances (user -> sandbox_id):')
    for r in (inst or []): print(f'  {r.get("sandbox_id"):28} user={r.get("user_id","")[:8]}')
    print('Supabase machine_pool:', [r.get('app_name') for r in (pool or [])])
    print('Railway vars to flip: FLY_API_TOKEN, FLY_SANDBOX_APP, FLY_SANDBOX_IMAGE, FLY_HARNESS_APP, BROWSER_ENGINE_HOST')

def cmd_cutover_plan(_):
    nm = nm_load()
    _, inst = sb('GET', 'instances?select=user_id,sandbox_id'); _, pool = sb('GET', 'machine_pool?select=id,app_name')
    print('instances:')
    for r in (inst or []):
        if r.get('sandbox_id'): print(f'  {r["sandbox_id"]} -> {resolve(r["sandbox_id"], nm)}')
    print('machine_pool:')
    for r in (pool or []):
        print(f'  {r["app_name"]} -> {resolve(r["app_name"], nm)}')
    print('(dry-run; run cutover-commit AFTER Railway is flipped + the new deploy is live)')

def cmd_cutover_commit(_):
    nm = nm_load()
    _, inst = sb('GET', 'instances?select=user_id,sandbox_id,sandbox_status,status'); _, pool = sb('GET', 'machine_pool?select=id,app_name')
    bk = f'{STAGE}/precutover-{int(time.time())}.json'; os.makedirs(STAGE, exist_ok=True)
    json.dump({'instances': inst, 'machine_pool': pool}, open(bk, 'w'), indent=2); print('backup ->', bk)
    for r in inst:
        new = resolve(r['sandbox_id'], nm) if r.get('sandbox_id') else None
        if not new: print(f'  ! no mapping for {r.get("sandbox_id")} — skip'); continue
        host = f'https://{new}.fly.dev'
        st, _ = sb('PATCH', f"instances?user_id=eq.{r['user_id']}", {'sandbox_id': new, 'server_url': host, 'sandbox_url': host, 'instance_type': 'cloud', 'sandbox_status': r.get('sandbox_status') or 'stopped', 'status': r.get('status') or 'stopped'})
        print(f'  instances {r["sandbox_id"]} -> {new} [{st}]')
    for r in pool:
        new = resolve(r['app_name'], nm)
        if not new: print(f'  ! pool {r["app_name"]} not in namemap — skip (run infra first)'); continue
        st, _ = sb('PATCH', f"machine_pool?id=eq.{r['id']}", {'app_name': new}); print(f'  pool {r["app_name"]} -> {new} [{st}]')
    _, chk = sb('GET', 'instances?select=sandbox_id')
    bad = [r for r in chk if r.get('sandbox_id') and not r['sandbox_id'].endswith(DST_SUFFIX)]
    print(f'VERIFY: {len(chk)} rows, {len(bad)} not {DST_SUFFIX}', '— re-run until 0 (deploy live)' if bad else 'ALL OK')

CMDS = {'list': cmd_list, 'image': cmd_image, 'infra': cmd_infra, 'data': cmd_data, 'roll': cmd_roll,
        'audit': cmd_audit, 'cutover-plan': cmd_cutover_plan, 'cutover-commit': cmd_cutover_commit}

if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help', 'help'): print(__doc__); sys.exit(0)
    c = sys.argv[1]
    if c not in CMDS: sys.exit(f'unknown subcommand {c}; run help')
    if not (SRC and DST): sys.exit('SRC_FLY_TOKEN and DST_FLY_TOKEN are required')
    CMDS[c](sys.argv[2:])
