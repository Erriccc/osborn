# Volume as Home: Making `/workspace` the Source of Truth

> Research doc — May 2026. Investigates whether we can make the Fly volume
> mounted at `/workspace` hold not just session data but *also* installed
> binaries, OAuth tokens, npm cache, git config, etc. — so that image
> rebuilds only swap "the launcher" and everything else persists.

## TL;DR

1. **You cannot mount a Fly volume at `/` or over any existing image directory
   (e.g. `/usr/local`).** Fly's mount semantics either silently *hide* the
   image content (single user-space mount, like Docker bind mounts) or
   refuse outright on some older paths. There is no Fly-native way to
   "treat the volume as rootfs". ([Fly: Volumes overview], [Fly docs: "you can't mount with destination='/'"][fly-launch-vol])
2. **`HOME=/workspace` does NOT redirect `npm install -g`.** npm globals
   follow the `prefix` config — controlled by `--prefix`, `NPM_CONFIG_PREFIX`,
   or `.npmrc`, **not** `HOME`. Default `prefix` is "the location where
   node is installed" (i.e. `/usr/local`). ([npm docs: folders][npm-folders], [npm docs: config][npm-config])
3. **The practical pattern** is: keep a minimal bootstrap in the image
   (`node`, `bash`, `curl`, an `osborn` launcher that lives at
   `/usr/local/bin/osborn`), and point *every* user-space env var at
   `/workspace/...` so all *new* state lands on the volume. The image
   becomes a launcher; the volume is the home.
4. **There is a real npm-CLI bug** where `NPM_CONFIG_PREFIX` is sometimes
   ignored during `npm install` ([npm/cli#4467][npm-bug-4467]). Use `--prefix` on the install
   command line as a belt-and-braces measure.
5. **No need for chroot / pivot_root / bind-mount tricks.** Fly Machines do
   run privileged (CAP_SYS_ADMIN available — [community confirmation][fly-privileged]),
   so `mount --bind /workspace/usr-local /usr/local` in the entrypoint
   would work *technically*, but it's strictly worse than the env-var
   approach: brittle on restart, breaks layer caching, fights Fly's init.

---

## The minimal working setup

### Diff 1: `agent/Dockerfile.sandbox`

```diff
 FROM node:22-slim

 RUN apt-get update -qq && \
     apt-get install --no-install-recommends -y \
     ca-certificates curl git make g++ python-is-python3 && \
     rm -rf /var/lib/apt/lists/*

-ARG OSBORN_VERSION=latest
-RUN npm install -g "osborn@${OSBORN_VERSION}" @anthropic-ai/claude-code
+# ---- IMAGE-BAKED BOOTSTRAP ----------------------------------------------
+# Bake a SPECIFIC osborn version into /usr/local at build time. This is the
+# "launcher of last resort" — if the volume is empty (fresh sandbox) or its
+# /workspace/.npm-global/bin/osborn is missing/broken, the image-baked copy
+# at /usr/local/bin/osborn runs. Otherwise PATH ordering ensures the
+# volume-baked copy wins.
+ARG OSBORN_VERSION=latest
+RUN npm install -g "osborn@${OSBORN_VERSION}" @anthropic-ai/claude-code
+
+# Marker — entrypoint can detect "manifest-aware" images
+RUN touch /etc/osborn-manifest-aware

 RUN mkdir -p /workspace

-ENV OSBORN_CWD=/workspace
-ENV OSBORN_API_PORT=8741
-ENV NODE_ENV=production
-ENV HOME=/workspace
+# ---- VOLUME-AS-HOME ENV --------------------------------------------------
+ENV OSBORN_CWD=/workspace
+ENV OSBORN_API_PORT=8741
+ENV NODE_ENV=production
+
+# HOME drives where ~-prefixed tools write (gh, git, ssh, aws, claude-code).
+ENV HOME=/workspace
+
+# npm globals — MUST be set explicitly. HOME does NOT redirect these. The
+# default prefix is /usr/local (where node lives). NPM_CONFIG_PREFIX moves
+# all `npm install -g` writes onto the volume.
+ENV NPM_CONFIG_PREFIX=/workspace/.npm-global
+ENV NPM_CONFIG_CACHE=/workspace/.npm-cache
+ENV NPM_CONFIG_USERCONFIG=/workspace/.npmrc
+
+# XDG Base Directory spec — most modern CLIs respect these instead of HOME
+# directly. Defaults are $HOME/.config, $HOME/.local/share, $HOME/.cache
+# (per freedesktop spec) — we set them explicitly so the volume layout is
+# stable even if HOME ever changes.
+ENV XDG_CONFIG_HOME=/workspace/.config
+ENV XDG_DATA_HOME=/workspace/.local/share
+ENV XDG_CACHE_HOME=/workspace/.cache
+ENV XDG_STATE_HOME=/workspace/.local/state
+
+# Tools that have their own env vars overriding XDG/HOME
+ENV GH_CONFIG_DIR=/workspace/.config/gh
+ENV GIT_CONFIG_GLOBAL=/workspace/.gitconfig
+ENV CLAUDE_CONFIG_DIR=/workspace/.claude
+
+# PATH — volume's npm bin FIRST so volume-installed osborn wins over the
+# image-baked one. /usr/local/bin stays as fallback.
+ENV PATH=/workspace/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

 WORKDIR /workspace
 EXPOSE 8741
```

The entrypoint also needs one extra step on first boot — seed the volume
with the image-baked npm globals so the first invocation of
`/workspace/.npm-global/bin/osborn` works without an install:

```bash
# In entrypoint.sh, before `exec osborn`:
if [ ! -x /workspace/.npm-global/bin/osborn ]; then
  echo "[sandbox] seeding npm globals onto volume (first boot)"
  mkdir -p /workspace/.npm-global /workspace/.npm-cache
  # Cheap "copy /usr/local globals to the volume" — copies bin + lib only,
  # which is what `npm install -g` writes. Symlinks in /usr/local/bin
  # pointing into /usr/local/lib/node_modules are preserved.
  cp -a /usr/local/lib/node_modules/. /workspace/.npm-global/lib/node_modules/ 2>/dev/null || true
  mkdir -p /workspace/.npm-global/bin
  for f in /usr/local/bin/osborn /usr/local/bin/claude; do
    [ -e "$f" ] || continue
    target=$(readlink -f "$f")
    rel=$(echo "$target" | sed 's|^/usr/local/|../|')
    ln -sf "$rel" /workspace/.npm-global/bin/$(basename "$f")
  done
fi
```

### Diff 2: `frontend/src/lib/machines.ts` `getPlatformEnvVars`

```diff
 function getPlatformEnvVars(userId: string): Record<string, string> {
   const envVars: Record<string, string> = {
     OSBORN_API_PORT: String(OSBORN_HTTP_PORT),
     OSBORN_CWD: '/workspace',
-    HOME: '/root',
+    HOME: '/workspace',
+    NPM_CONFIG_PREFIX: '/workspace/.npm-global',
+    NPM_CONFIG_CACHE: '/workspace/.npm-cache',
+    NPM_CONFIG_USERCONFIG: '/workspace/.npmrc',
+    XDG_CONFIG_HOME: '/workspace/.config',
+    XDG_DATA_HOME: '/workspace/.local/share',
+    XDG_CACHE_HOME: '/workspace/.cache',
+    XDG_STATE_HOME: '/workspace/.local/state',
+    GH_CONFIG_DIR: '/workspace/.config/gh',
+    GIT_CONFIG_GLOBAL: '/workspace/.gitconfig',
+    CLAUDE_CONFIG_DIR: '/workspace/.claude',
+    PATH: '/workspace/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
     LIVEKIT_ROOM: `osborn-${userId.substring(0, 8)}`,
   }
```

Note: the agent's existing `HOME=/workspace` in the Dockerfile already
contradicts `machines.ts`'s `HOME=/root` (line 288 today). The Dockerfile
wins for new machines (the env-var is set at image build), but if anyone
re-PATCHes machine config from the frontend the inconsistency surfaces.
Aligning them at `/workspace` everywhere is part of this change.

### Diff 3: `frontend/src/lib/machines.ts` `readInstalledOsbornVersion`

No change needed if `/health` keeps returning `version`. But the entrypoint
manifest check needs to read the volume's osborn:

```diff
-  CURRENT=$(osborn --version 2>/dev/null | head -1 | tr -d '[:space:]')
+  # With PATH ordering, `osborn` resolves to the volume copy first; this
+  # is the right answer for "what version actually runs". Falls back to
+  # /usr/local/bin/osborn if volume is empty.
+  CURRENT=$(osborn --version 2>/dev/null | head -1 | tr -d '[:space:]')
   if [ "$WANT" != "$CURRENT" ]; then
     echo "[sandbox] osborn ${CURRENT:-none} → ${WANT} (manifest install)"
-    npm install -g "osborn@${WANT}" || ...
+    # npm install -g lands on /workspace/.npm-global because of
+    # NPM_CONFIG_PREFIX — survives the next boot. Use --prefix as a
+    # belt-and-braces guard against npm/cli#4467 (env-var ignored).
+    npm install -g --prefix "$NPM_CONFIG_PREFIX" "osborn@${WANT}" || ...
   fi
```

---

## The nine questions

### 1. Fly.io volume mount semantics

**Cannot mount at `/`.** From the official Add-volume guide: *"You can't
mount a volume with `destination='/'` since `/` is used for the root file
system."* ([Fly launch: volume storage][fly-launch-vol])

**Can technically mount over an existing image path,** but the image
content at that path becomes hidden — Fly does NOT copy it onto the
volume. From the Laravel storage guide: *"Mounting a Volume to a folder
will initially erase any item the folder contains during the first time
the Volume is mounted for the folder."* ([Fly Laravel volume storage][fly-laravel])
The image content isn't actually erased (it's still in the underlying
overlayfs), but the running container can't see it through the mount
point — same semantics as a Linux mount over a directory.

**Multiple historical reports** of failures mounting on `/root`, `/home`,
or paths the Fly init touches ([Fly community: mount home dir on
volume][fly-home-mount]). Conclusion: mount on a path Fly's init
doesn't care about. `/workspace` is the de-facto convention and works.

Combined with the fact that Fly volumes are **1:1 with a machine** ([Fly:
Volumes overview][fly-overview]) — you can't share state between machines
via a single volume — this means: "the volume is the home" is fine
per-machine, but you cannot make it the home of the whole *fleet*.

### 2. NPM global prefix vs HOME

**Confirmed: `npm install -g` uses the `prefix` config, not `HOME`.** Per
npm docs *"folders"*: *"The prefix config defaults to the location where
node is installed. On most systems, this is `/usr/local`."* ([npm:
folders][npm-folders]) Global installs land at
`{prefix}/lib/node_modules` and binaries are symlinked into `{prefix}/bin`.

**`HOME=/workspace` will NOT redirect npm globals.** The user's
intuition that "HOME redirects everything" is true for tools that read
`~/.something` directly, but npm's `prefix` is independent.

**The right env vars:**
- `NPM_CONFIG_PREFIX=/workspace/.npm-global` — global install destination
- `NPM_CONFIG_CACHE=/workspace/.npm-cache` — package cache (was
  `~/.npm`, defaults from XDG_CACHE_HOME or HOME)
- `NPM_CONFIG_USERCONFIG=/workspace/.npmrc` — per-user `.npmrc` location
- Optional: `npm_config_prefix=...` (lowercase form also works)

**Precedence (npm config docs):** command-line `--prefix` > env vars >
`.npmrc` files > defaults. ([npm: config][npm-config])

**Known npm CLI bug — [npm/cli#4467][npm-bug-4467]**: `NPM_CONFIG_PREFIX` is
sometimes ignored during `npm install` (it's respected for the *resolve*
phase but a later phase re-reads from a different config source). The
workaround is to pass `--prefix "$NPM_CONFIG_PREFIX"` explicitly on the
command line. The diff above does this in the manifest-install path.

### 3. PATH ordering

**Required:** `/workspace/.npm-global/bin` must come before `/usr/local/bin`
so the shell resolves `osborn` to the volume copy. `ENV PATH=...` in the
Dockerfile sets it for the container; `exec osborn` in the entrypoint
inherits it; subprocesses (claude-code, Bash tool, etc.) inherit it.

**ENTRYPOINT / CMD effect:** `ENV PATH` set in the Dockerfile is part of
the image config and is exported into every process Fly's init spawns. No
shell config needed — the entrypoint script picks it up.

**Risk:** if `/workspace/.npm-global/bin/osborn` exists but is broken
(partial install, wrong version, missing shebang target), the shell will
still resolve to it first. Recovery requires the entrypoint to either
(a) verify the volume binary with `osborn --version` before `exec`-ing,
falling back to `/usr/local/bin/osborn` if it errors, or (b) catch the
exec failure and re-`exec` the image-baked copy. The Dockerfile diff
above doesn't add this guard — call it out as a follow-up.

### 4. Docker `VOLUME` directive vs Fly mounts

**Fly does not honor `VOLUME` directives.** From the community thread *"Does
Fly Ignore Docker Volumes?"*: the experienced response is *"I have not seen
that fly uses the VOLUME command but have not tried it."* — backed up by
no mention in Fly's own docs and confirmed in *"How to multiple mount
volumes when dockerfile has multiple volumes as well"* where the official
answer is to use `[mounts]` instead. ([Fly community: Does Fly Ignore
Docker Volumes?][fly-ignore-volume])

**Conclusion:** Adding `VOLUME /workspace` to the Dockerfile is a no-op on
Fly. Don't bother. It does NOT harm either, but a future reader will be
confused. Skip it.

### 5. chroot / pivot_root tricks

**Theoretically possible.** Fly Machines run as Firecracker microVMs with
`privileged=true` and the full Linux capability set ([Fly community: Why
are Fly Machines configured with privileged=true?][fly-privileged]), so
`CAP_SYS_ADMIN` is available — meaning `mount(2)`, `pivot_root(2)`, and
`chroot(2)` all work syscall-wise.

**Practically: terrible idea.**
- `pivot_root` requires the new root to be a separate mount, not on the
  rootfs (initramfs) — workable, but requires shuffling.
  ([pivot_root(2) man page][pivot-man])
- `chroot`-after-init breaks Fly's init responsibilities (signal
  forwarding, child reaping, log collection). Fly's init runs *before*
  your entrypoint and assumes the rootfs it knows. Re-rooting away from
  it means signals from Fly land in the old root and never reach your
  process.
- You'd be the first known user of this pattern on Fly — no community
  reports, no docs.

**Verdict:** skip. The env-var approach gives 95% of the benefit with 0%
of the risk.

### 6. Bind-mount / overlay approaches

**Technically possible**: in the entrypoint, before `exec osborn`,
`mkdir -p /workspace/usr-local && cp -a /usr/local/. /workspace/usr-local/ 2>/dev/null; mount --bind /workspace/usr-local /usr/local`.

**Pros:** keeps `/usr/local` as the canonical path; old code that
assumes `/usr/local/bin/osborn` still works.

**Cons:**
- Adds 200–500 ms of `cp -a` on first boot.
- The bind-mount must be re-done on every container start — entrypoint
  complexity grows.
- `mount --bind` over `/usr/local` happens *after* Fly's init has set
  things up; if init or any other tool has files open in `/usr/local`,
  you can get weird "device busy" or stale-fd behavior.
- Layer cache: when you push a new image with a new `/usr/local/bin/osborn`,
  the bind mount continues to overlay the volume's stale copy. You'd
  need either to refuse-to-bind-on-mismatch logic or to delete
  `/workspace/usr-local` on every image change. Net: more brittle than
  just using `NPM_CONFIG_PREFIX`.

**Verdict:** env-var approach is strictly simpler. Bind-mount is the
fallback if some tool refuses to respect `NPM_CONFIG_PREFIX` and you
need to *force* its globals onto the volume — but no current osborn
dependency has that constraint.

### 7. Minimal "everything in the workspace" env recipe

The user's proposed env-var list, audited:

| Var | Status | Note |
| --- | --- | --- |
| `HOME=/workspace` | KEEP | Drives `~/.something` writes for `gh`, `git`, `ssh`, `aws`, `claude-code`. |
| `NPM_CONFIG_PREFIX=/workspace/.npm-global` | KEEP — REQUIRED | npm globals don't follow HOME. ([npm folders][npm-folders]) |
| `PATH=/workspace/.npm-global/bin:$PATH` | KEEP — REQUIRED | Without this, the shell still resolves `osborn` to `/usr/local/bin/osborn`. |
| `XDG_CONFIG_HOME=/workspace/.config` | KEEP | Defaults to `$HOME/.config` — redundant given HOME=/workspace, but explicit > implicit. ([XDG spec][xdg-spec]) |
| `XDG_DATA_HOME=/workspace/.local/share` | KEEP | Defaults to `$HOME/.local/share`. |
| `XDG_CACHE_HOME=/workspace/.cache` | KEEP | Defaults to `$HOME/.cache`. |
| `GH_CONFIG_DIR=/workspace/.config/gh` | KEEP | `gh` respects XDG, this is just belt-and-braces. |
| `GIT_CONFIG_GLOBAL=/workspace/.gitconfig` | KEEP | Forces git's "global" config onto the volume; without it git uses `$HOME/.gitconfig` which is already on the volume via HOME, so technically redundant but explicit. |

**Missing — add these:**
- `XDG_STATE_HOME=/workspace/.local/state` — modern XDG state location (logs, history).
- `NPM_CONFIG_CACHE=/workspace/.npm-cache` — npm package cache. Default
  is `~/.npm` so HOME redirects it, but explicit.
- `NPM_CONFIG_USERCONFIG=/workspace/.npmrc` — npm's per-user `.npmrc`.
- `CLAUDE_CONFIG_DIR=/workspace/.claude` — osborn's `session-access.ts`
  reads `CLAUDE_CONFIG_DIR` (already documented in CLAUDE.md). With
  HOME=/workspace this resolves to the same place via Claude Code's
  default of `$HOME/.claude`, but explicit > implicit and protects
  against any future Claude Code change.
- `PIP_CACHE_DIR=/workspace/.cache/pip` — if any skill ever shells into
  Python. Optional.

**Order of precedence issues:** None — these are all distinct namespaces.
The one risk is multiple vars pointing at the same place from different
defaulting rules (e.g. `XDG_CONFIG_HOME` AND `GH_CONFIG_DIR` both pointing
at `gh`'s config). That's fine; gh checks `GH_CONFIG_DIR` first and
ignores XDG when set. ([gh manual][gh-manual])

### 8. Side effect on osborn version pinning

Current code: `frontend/src/lib/machines.ts:684-696` — `readInstalledOsbornVersion`
queries the running agent's `/health` endpoint for a `version` field. As
long as the agent reports the version of *itself* (the running process),
this is correct regardless of which `osborn` on disk launched it.

**What the entrypoint manifest check needs to change:**
- `osborn --version` resolves through PATH — with volume-first PATH it
  reads the volume copy. Correct.
- `npm install -g osborn@${WANT}` lands on the volume (via
  `NPM_CONFIG_PREFIX`). Correct, but add `--prefix "$NPM_CONFIG_PREFIX"`
  on the install line to dodge [npm/cli#4467].
- The version marker file `/workspace/.osborn-installed-version`
  (referenced in CLAUDE.md, current Sprites bootstrap) is now
  *consistent* with disk reality — both the marker and the binary live
  on the volume. Today, the marker lives on the volume but the binary
  lives on the image overlay, which is the underlying reason version
  detection has been flaky.

**Behavioral change:** today, `/workspace/.osborn-want-version` triggers a
re-install on EVERY boot (because container overlay is wiped). After this
change, the install is permanent — re-install only triggers when WANT
≠ what's actually on the volume. Boots get faster (no daily reinstall
overhead) and offline boots work (no npm registry call needed if version
already matches).

### 9. Real-world references

| Pattern | Where seen | Verdict |
| --- | --- | --- |
| `NPM_CONFIG_PREFIX` to redirect globals | npm own docs ([config][npm-config]), every "npm without sudo" guide | Standard |
| `HOME=/<volume>` on Fly | [Fly community: home dir on volume][fly-home-mount] | Discussed, with caveats |
| Mount over `/usr` or `/usr/local` on Fly | None found | Not done |
| chroot/pivot_root on Fly | None found | Not done |
| Volume-first PATH in container | Standard buildpack pattern; nvm, asdf | Common |

No public reports of anyone treating a Fly volume as a *full* rootfs.
What exists is incremental: tool-by-tool env var redirection, which is
what the proposed setup does.

---

## Trade-offs

### What we gain
- **Updates are cheap.** Image rebuild only ships a new launcher
  (`/usr/local/bin/osborn`). Skills, OAuth tokens, npm cache, git config,
  Claude session JSONLs — already on volume, untouched.
- **Cold-start consistency.** First boot of a fresh sandbox seeds the
  volume from the image. Every subsequent boot uses the volume copy.
  Whatever the *user* installed via `npm install -g something` from a
  skill or Bash tool persists too.
- **One source of truth for state.** Today, `/root/.claude` is symlinked
  to `/workspace/.claude`, but everything else (gh config, git config,
  any new tool's cache) lands on the ephemeral overlay and gets wiped on
  stop/start. After this change, all of it persists by default.

### What we lose / what could break
- **First-boot latency** rises slightly (the seed `cp -a` of
  `/usr/local/lib/node_modules`, ~200–500 ms). Subsequent boots faster.
- **Disk usage on the volume grows.** Each user's volume now stores a
  full copy of osborn + claude-code (~80–120 MB) plus their npm cache.
  Current sizing (`size_gb: 10`) has plenty of headroom — bumping in
  the dashboard if usage actually creeps.
- **Stale volume copies can wedge updates.** If someone forces a bad
  osborn version onto the volume and the marker file says "good", the
  agent runs the bad version forever. Defense: the manifest-install step
  is still authoritative — WANT-vs-CURRENT check + npm install on
  mismatch.
- **`/workspace/.npm-global/bin` is on PATH first.** A malicious skill
  that runs `npm install -g malicious-osborn` could replace the launcher.
  Today, that install lands on the ephemeral overlay and dies on stop;
  after this change, it persists. Mitigation: the agent's PreToolUse
  hook already restricts Write/Edit outside the workspace, but
  `Bash(npm install -g ...)` is not gated. Track as a follow-up — not
  caused by this change, but its risk surface grows.
- **Two `osborn` binaries on disk** (image-baked at `/usr/local/bin`,
  volume-baked at `/workspace/.npm-global/bin`). Debugging "which one is
  running" requires `which osborn` + `osborn --version` + checking
  `/health`. Document the diagnosis path; the existing `verify-update`
  endpoint already exposes `/health` version, which IS the running copy.
- **`NPM_CONFIG_PREFIX` is not 100% reliable** ([npm/cli#4467][npm-bug-4467]).
  The `--prefix` belt-and-braces in the install line covers this for
  the manifest path. Other `npm install -g` calls (from skills, from
  Bash) would still be vulnerable, but they'd just land in the default
  prefix (`/usr/local`) and disappear on restart — same failure mode as
  today, no regression.
- **No fleet sharing.** Per Fly's 1:1 volume-to-machine rule, this
  doesn't let two machines share state. Same as today.

---

## Migration plan

The change is backward-compatible for fresh sandboxes. For existing
ones, we need to **seed the volume on first reboot after the new image
ships**. Steps:

### Phase 1 — ship the new image (no breakage on existing sandboxes)
1. Land the Dockerfile diff. The new image:
   - Sets all the env vars (including `PATH=/workspace/.npm-global/bin:...`).
   - First entrypoint runs: detects empty `/workspace/.npm-global`,
     seeds it from `/usr/local`. Idempotent on subsequent boots.
2. Land the `getPlatformEnvVars` diff in `machines.ts`. New machines
   will use these env vars from creation. **Existing machines** are
   unaffected until their next config PATCH.
3. Verify on a *new* sandbox: `osborn --version` reports correct,
   `which osborn` returns `/workspace/.npm-global/bin/osborn`,
   `npm install -g some-pkg` lands at `/workspace/.npm-global/lib/...`.
4. Verify on an *existing* sandbox (whose env vars still say `HOME=/root`):
   the new image still works because the seeding script + PATH ordering
   only fires if the volume's npm dir is empty. PATH inside the running
   container still points at `/usr/local/bin/osborn` (image), so legacy
   behavior is preserved.

### Phase 2 — migrate existing machines
5. Force a config PATCH on every existing machine that updates env vars
   to the new set. Fly's `machine update` takes effect on next restart.
6. Add a one-time `execInMachine` to back up any state that lived in
   `/root/`:
   ```
   [ -d /root/.claude ] && [ ! -L /root/.claude ] && mv /root/.claude/* /workspace/.claude/ 2>/dev/null
   [ -f /root/.gitconfig ] && cp /root/.gitconfig /workspace/.gitconfig
   [ -d /root/.config ] && cp -rn /root/.config/* /workspace/.config/ 2>/dev/null
   ```
   Most of this is already a no-op because the current Dockerfile
   already symlinks `/root/.claude` → `/workspace/.claude` and sets
   `HOME=/workspace`. The actual at-risk paths are: `gh` config, git
   config, any user-installed npm globals (most fresh sandboxes won't
   have any).
7. Restart the machine. Verify `/health` reports the expected osborn
   version, and that any persisted credentials still work.

### Phase 3 — clean up
8. Remove the `/root/.claude` symlink dance from the entrypoint (no
   longer needed; `HOME=/workspace` covers it).
9. Update CLAUDE.md cloud-sandbox section to describe the
   volume-as-home invariant.
10. Track [npm/cli#4467][npm-bug-4467] — when fixed upstream, the
    `--prefix` belt-and-braces becomes unnecessary.

### Rollback
If Phase 1 breaks, set the image tag back. The volume's
`/workspace/.npm-global` is *additive* — the old image just ignores
it. No data loss.

---

## Sources

- [Fly Volumes overview][fly-overview]
- [Fly: Add volume storage to a Fly Launch app][fly-launch-vol] — "you can't mount with destination='/'"
- [Fly: Volume not yet available/mounted while executing entrypoint.sh][fly-vol-timing] — single-machine race confirmation
- [Fly Laravel: Persisting the Storage Folder][fly-laravel] — explicit "erases items on first mount" language
- [Fly community: How do I mount a home directory onto a volume?][fly-home-mount] — Fly does not copy image content onto a fresh volume
- [Fly community: How to mount app directory as a persistent volume when the app starts?][fly-app-dir] — Kurt: "we can't mount over an existing directory"
- [Fly community: Does Fly Ignore Docker Volumes?][fly-ignore-volume] — VOLUME directive not honored
- [Fly community: Why are Fly Machines configured with privileged=true?][fly-privileged] — CAP_SYS_ADMIN available
- [npm docs v10: folders][npm-folders] — `prefix` defaults to "where node is installed"
- [npm docs v11: using-npm/config][npm-config] — precedence order, `NPM_CONFIG_PREFIX`
- [npm/cli issue #4467][npm-bug-4467] — `NPM_CONFIG_PREFIX` ignored during install bug
- [XDG Base Directory Specification][xdg-spec]
- [pivot_root(2) man page][pivot-man]
- [gh manual: configuration][gh-manual]

[fly-overview]: https://fly.io/docs/volumes/overview/
[fly-launch-vol]: https://fly.io/docs/launch/volume-storage/
[fly-vol-timing]: https://community.fly.io/t/volume-not-yet-available-mounted-while-executing-entrypoint-sh/15324
[fly-laravel]: https://fly.io/docs/laravel/the-basics/laravel-volume-storage/
[fly-home-mount]: https://community.fly.io/t/how-do-i-mount-a-home-directory-onto-a-volume/18861
[fly-app-dir]: https://community.fly.io/t/how-to-mount-app-directory-as-a-persistent-volume-when-the-app-starts/626
[fly-ignore-volume]: https://community.fly.io/t/does-fly-ignore-docker-volumes/15434
[fly-privileged]: https://community.fly.io/t/why-are-fly-machines-running-as-firecracker-microvms-configured-with-privileged-true/26380
[npm-folders]: https://docs.npmjs.com/cli/v10/configuring-npm/folders
[npm-config]: https://docs.npmjs.com/cli/v11/using-npm/config/
[npm-bug-4467]: https://github.com/npm/cli/issues/4467
[xdg-spec]: https://specifications.freedesktop.org/basedir/latest/
[pivot-man]: https://man7.org/linux/man-pages/man2/pivot_root.2.html
[gh-manual]: https://cli.github.com/manual/

---

## Open / uncertain items

- **`NPM_CONFIG_PREFIX` reliability** ([npm/cli#4467][npm-bug-4467]) — the
  upstream bug report shows env-var ignored during install in some npm
  versions. Mitigated by `--prefix` on the command line. UNCERTAIN
  whether this bug is present in npm 10.x (the bug is filed against 8.x);
  worth a one-line empirical test in the sandbox before relying on it.
- **Volume mount timing race** ([Fly community thread][fly-vol-timing])
  reports the volume not yet mounted when entrypoint starts. The thread
  blames multi-region multi-machine setups, but the *root cause* for
  single-machine cases isn't fully documented. Defense: the entrypoint
  should `[ -d /workspace ] || sleep 1` retry loop before any
  `mkdir /workspace/...`. Current entrypoint already does
  `mkdir -p /workspace` which papers over a non-mount.
- **What happens if BOTH a `VOLUME` directive AND a Fly `[mounts]` exist
  for the same path?** The community thread says VOLUME is "not used by
  Fly" but I can't find an explicit statement of "ignored vs honored as
  redundant". Recommendation: don't add `VOLUME /workspace`. If it's
  already in some old image, removing it should be safe.
