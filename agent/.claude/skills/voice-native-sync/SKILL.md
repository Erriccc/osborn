# Voice Native Sync Skill

## SKILL IDENTITY
Name: voice-native-sync
Install path: ~/.claude/skills/voice-native-sync/SKILL.md

## TRIGGER PHRASES
This skill activates when the user says any of:
- "upload to voice native"
- "download from voice native"
- "sync to voice native"
- "push sessions to voice native"
- "pull sessions from voice native"
- "sync my sessions"

When triggered, follow the instructions below immediately without asking for clarification,
unless credentials are missing (see CREDENTIALS section).

---

## SELF-INSTALL
If the user asks you to install this skill or you fetched this file from a URL,
save it to: ~/.claude/skills/voice-native-sync/SKILL.md

```bash
mkdir -p ~/.claude/skills/voice-native-sync
# then write this file's content to ~/.claude/skills/voice-native-sync/SKILL.md
```

After saving, confirm: "Voice Native sync skill installed. Use 'upload to voice native' or 'download from voice native' any time."

---

## CREDENTIALS
Credentials are stored at: ~/.claude/skills/voice-native-sync/config

Config file format:
```
CLOUD_URL=https://osborn-XXXX.fly.dev
TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

If the config file doesn't exist:
1. Tell the user: "I need your Voice Native sync credentials. Go to voice-native.com → Settings → Copy sync info, then paste it here."
2. Parse the pasted block for CLOUD_URL (the "Server:" line) and TOKEN (the "Token:" line)
3. Save to ~/.claude/skills/voice-native-sync/config
4. Proceed with the requested operation

---

## UPLOAD (Local → Voice Native Cloud)

Uploads all local Claude session files to the Voice Native fly machine.
Uses chunked upload + finalize. Safe to re-run — mtime-newer-wins per file.

### Execute as a single script (one permission prompt):

```bash
set -e

# Load credentials
source ~/.claude/skills/voice-native-sync/config

TARGET_PATH="/workspace"

rm -f /tmp/vn-sync.tar.gz /tmp/vn-chunk-*

# Archive local Claude projects (exclude macOS AppleDouble files)
tar -czf /tmp/vn-sync.tar.gz \
  $(uname | grep -qi darwin && echo '--exclude=._*') \
  -C "$HOME/.claude" projects

echo "archive: $(du -sh /tmp/vn-sync.tar.gz | cut -f1)"

# Split into 50MB chunks
split -b 50m /tmp/vn-sync.tar.gz /tmp/vn-chunk-
CHUNKS=(/tmp/vn-chunk-*)
TOTAL=${#CHUNKS[@]}
echo "chunks: $TOTAL"

# Generate upload ID (works on Linux and macOS)
if command -v uuidgen &>/dev/null; then
  UPLOAD_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
else
  UPLOAD_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())")
fi
echo "upload id: $UPLOAD_ID"

# Upload chunks
idx=0
for chunk in "${CHUNKS[@]}"; do
  echo "uploading chunk $idx / $((TOTAL-1))..."
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${chunk}" \
    "${CLOUD_URL}/sessions/import-chunk?uploadId=${UPLOAD_ID}&chunk=${idx}")
  echo "  chunk $idx → HTTP $STATUS"
  idx=$((idx+1))
done

# Finalize — merges chunks and extracts WITHOUT slug remapping.
# IMPORTANT: do NOT pass `targetWorkDir`. The server-side remap collapses every
# source slug into the target work dir's slug, which causes session-resume to
# silently break when sessions are uploaded from different hosts (Mac, Codespace,
# Sprite) — they all end up in -workspace, the JSONLs internally still reference
# their original cwd, the slug↔cwd no longer match, and Claude Code's resume
# can't find the file. Confirmed 2026-05-27: a codespace upload remapped
# -workspaces-codespaces-blank → -workspace and every codespace session went
# silent on resume. The fix is to preserve each upload's original slug structure.
echo "finalizing..."
RESULT=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "${CLOUD_URL}/sessions/import-finalize?uploadId=${UPLOAD_ID}&total=${TOTAL}")
echo "finalize result: $RESULT"

# Cleanup
rm -f /tmp/vn-sync.tar.gz /tmp/vn-chunk-*

# Verify
echo "verifying manifest..."
curl -s -H "Authorization: Bearer $TOKEN" "${CLOUD_URL}/sessions/manifest" | \
  python3 -c "
import json,sys
d=json.load(sys.stdin)
slugs=d.get('slugs',{})
total=sum(len(v.get('files',{})) for v in slugs.values())
print(f'  cloud now has {len(slugs)} slug(s), {total} total files')
for slug,info in slugs.items():
  files=info.get('files',{})
  print(f'  {slug}: {len(files)} files')
"
```

---

## DOWNLOAD (Voice Native Cloud → Local)

Downloads all sessions from the Voice Native fly machine and merges into local ~/.claude/projects/.
Mtime-newer-wins — local files newer than cloud are preserved.

### Execute as a single script:

```bash
set -e

# Load credentials
source ~/.claude/skills/voice-native-sync/config

# Get local working directory for slug remapping
LOCAL_CWD="$(pwd)"
echo "local target cwd: $LOCAL_CWD"

rm -f /tmp/vn-download.tar.gz

# Download full export from fly machine
echo "downloading from $CLOUD_URL..."
curl -f -L \
  -H "Authorization: Bearer $TOKEN" \
  "${CLOUD_URL}/sessions/export" \
  -o /tmp/vn-download.tar.gz
echo "downloaded: $(du -sh /tmp/vn-download.tar.gz | cut -f1)"

# Import with slug remapping to local cwd
echo "importing..."
# Same fix as upload: no targetWorkDir, preserve original slug structure.
RESULT=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@/tmp/vn-download.tar.gz" \
  "${CLOUD_URL}/sessions/import")
echo "import result: $RESULT"

rm -f /tmp/vn-download.tar.gz

echo "done — sessions merged into ~/.claude/projects/"
```

Wait — the DOWNLOAD direction means pulling from cloud to THIS local machine.
The import endpoint runs on the cloud. For download to local, use this instead:

```bash
set -e
source ~/.claude/skills/voice-native-sync/config

LOCAL_CWD="$(pwd)"
rm -f /tmp/vn-download.tar.gz

echo "downloading export from $CLOUD_URL..."
curl -f -H "Authorization: Bearer $TOKEN" \
  "${CLOUD_URL}/sessions/export" \
  -o /tmp/vn-download.tar.gz
echo "downloaded: $(du -sh /tmp/vn-download.tar.gz | cut -f1)"

# Extract archive
mkdir -p /tmp/vn-extract
tar -xzf /tmp/vn-download.tar.gz -C /tmp/vn-extract

# Remap and merge into local ~/.claude/projects/
LOCAL_SLUG=$(echo "$LOCAL_CWD" | sed 's|/|-|g')
PROJECTS_DIR="$HOME/.claude/projects"
mkdir -p "${PROJECTS_DIR}/${LOCAL_SLUG}"

echo "merging into ${PROJECTS_DIR}/${LOCAL_SLUG}..."
for slug_dir in /tmp/vn-extract/projects/*/; do
  slug=$(basename "$slug_dir")
  for f in "${slug_dir}"*.jsonl "${slug_dir}"*.jsonl.* 2>/dev/null; do
    [ -f "$f" ] || continue
    fname=$(basename "$f")
    dest="${PROJECTS_DIR}/${LOCAL_SLUG}/${fname}"
    if [ ! -f "$dest" ] || [ "$f" -nt "$dest" ]; then
      cp "$f" "$dest"
      echo "  wrote $fname"
    fi
  done
done

rm -rf /tmp/vn-download.tar.gz /tmp/vn-extract
echo "done — sessions available at ${PROJECTS_DIR}/${LOCAL_SLUG}/"
```

---

## TECHNICAL NOTES
- Cloud target path is always `/workspace` (Fly.io machines)
- Slug remapping is automatic on upload (source slug → /workspace slug)
- Mtime-newer-wins: re-syncing is always safe, newer file wins per-file
- gzip only — never use zstd (server doesn't support it)
- macOS: always pass `--exclude='._*'` to tar (BSD tar emits AppleDouble files)
