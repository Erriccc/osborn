import { NextResponse } from 'next/server'

export async function GET() {
  const skillContent = `# Osborn Session Sync Skill

## DIRECTION — Upload or Download?

Before running, decide which direction you need:
- **UPLOAD (Local → Cloud)**: Push your local session files to the remote cloud instance for backup or to continue on another device
- **DOWNLOAD (Cloud → Local)**: Pull sessions from the remote cloud instance back to your local machine

Ask the user which they want, then run the appropriate section below.

---

## WHEN TO USE
When the user wants to sync their local Claude Code session files to their Osborn sprite for backup or migration. This makes session memory available across devices.

## WHAT YOU NEED
From the Osborn dashboard (voice-native.com), copy the sync info block which gives you three values:
- CLOUD_URL (e.g. https://osborn-abc123.sprites.app)
- TOKEN (your sync token)
- TARGET_PATH (e.g. /home/sprite/workspace)

## HOW TO EXECUTE — IMPORTANT: Use a sub-agent with auto-approve

Delegate the entire sync to a sub-agent. Do NOT run individual tool calls interactively — that forces the user to approve every curl and bash call. Instead, write a single shell script and execute it in one step so only one permission approval is needed.

### Step 1 — Get the manifest
Fetch the current state of what's already on the cloud instance:
curl -s -H "Authorization: Bearer $TOKEN" "$CLOUD_URL/sessions/manifest"

### Step 2 — Write a sync script to /tmp/osborn-sync.sh

Write the complete script as a single file, then execute it. The script should:

1. Set the three variables (CLOUD_URL, TOKEN, TARGET_PATH)
2. Determine the local slug: the current Claude projects directory path with / replaced by -
   - Local projects dir is typically: $HOME/.claude/projects
   - Slug example: -Users-yourname-Desktop-Developer-osborn
3. Create a gzip archive — ALWAYS use gzip, NOT zstd (server doesn't support zstd):
   cd ~/.claude/projects && tar -czf /tmp/osborn-sync.tar.gz --exclude='._*' -- <slug>/*.jsonl
   Note: --exclude='._*' is required on macOS BSD tar to prevent AppleDouble metadata files (macOS BSD tar only — not needed on Linux/Windows)
   Note: the -- before slug prevents tar treating the leading - as a flag
4. Split into 50MB chunks for parallel upload:
   split -b 50m /tmp/osborn-sync.tar.gz /tmp/osborn-chunk-
5. Generate a unique upload ID: UPLOAD_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
6. Upload all chunks in parallel (use & for background jobs):
   for i, enumerate chunks:
     curl -s -X POST \\
       -H "Authorization: Bearer $TOKEN" \\
       -H "Content-Type: application/octet-stream" \\
       --data-binary @/tmp/osborn-chunk-<suffix> \\
       "$CLOUD_URL/sessions/import-chunk?uploadId=$UPLOAD_ID&chunkIndex=<n>" &
   wait  # wait for all parallel uploads to complete
7. Finalize — assembles all chunks and extracts:
   curl -s -X POST \\
     -H "Authorization: Bearer $TOKEN" \\
     "$CLOUD_URL/sessions/import-finalize?uploadId=$UPLOAD_ID&targetWorkDir=$TARGET_PATH"
8. Verify — fetch manifest again and confirm slug appears:
   curl -s -H "Authorization: Bearer $TOKEN" "$CLOUD_URL/sessions/manifest"

### Step 3 — Execute the script
Run: bash /tmp/osborn-sync.sh

### Step 4 — Report results
After the script finishes, report: how many files were uploaded, whether the manifest shows the slug, and any errors.

## TECHNICAL NOTES
- Server auto-detects gzip vs plain tar via zlib stream sniffing (v0.9.15+) — no Content-Type header needed
- Always use gzip (-czf). Never use zstd — server does not support it
- Parallel chunked upload: all chunks return HTTP 200 independently; finalize assembles them
- Slug remapping is automatic: your local slug is remapped to the cloud instance's target path
- The sync is safe to re-run: existing files are not overwritten (no-overwrite behavior)
- macOS BSD tar only: always use --exclude='._*' to prevent AppleDouble metadata files in the archive; Linux and Windows tar do not produce these files

---

## DOWNLOAD (Cloud → Local)

Pulls all session files from the remote cloud instance and merges them into your local \`~/.claude/projects/\`.

### What you need
Same three variables from the Osborn dashboard:
- CLOUD_URL
- TOKEN
- TARGET_PATH (the cloud instance's working directory, e.g. /home/sprite/workspace)

### How to execute — single script, one approval

Write this script to /tmp/osborn-download.sh and run it in one bash execution:

\`\`\`bash
#!/bin/bash
set -e

CLOUD_URL="<YOUR_CLOUD_URL>"
TOKEN="<YOUR_TOKEN>"

# Download the gzipped tar from the sprite
echo "Downloading sessions from sprite..."
curl -s -f \\
  -H "Authorization: Bearer $TOKEN" \\
  "$CLOUD_URL/sessions/export?workDir=/home/sprite/workspace" \\
  -o /tmp/osborn-sessions.tar.gz

echo "Download complete. Extracting..."
mkdir -p /tmp/osborn-extract
tar -xzf /tmp/osborn-sessions.tar.gz -C /tmp/osborn-extract

# The tar contains a \`projects/\` folder at the top level
# Inside is a slug folder named after the sprite's path: -home-sprite-workspace
# We need to rename it to match the local slug

LOCAL_SLUG=$(echo "$HOME/.claude/projects" | sed 's|/|-|g' | sed 's|^-||')
SPRITE_SLUG="-home-sprite-workspace"

EXTRACT_DIR="/tmp/osborn-extract/projects"

merge_jsonl() {
  local src="$1"   # file from sprite
  local dest="$2"  # local file

  if [ ! -f "$dest" ]; then
    cp "$src" "$dest"
    return
  fi

  # Extract last timestamp from each JSONL file
  get_ts() {
    local f="$1"
    if command -v jq &>/dev/null; then
      tail -1 "$f" | jq -r '.timestamp // .ts // ""' 2>/dev/null
    else
      tail -1 "$f" | grep -o '"timestamp":"[^"]*"' | cut -d'"' -f4 2>/dev/null
    fi
  }

  local sprite_ts local_ts
  sprite_ts=$(get_ts "$src")
  local_ts=$(get_ts "$dest")

  # ISO 8601 timestamps sort lexicographically — string compare works
  if [ -n "$sprite_ts" ] && [ "$sprite_ts" > "$local_ts" ]; then
    cp "$src" "$dest"
    echo "  Updated: $(basename $dest) (sprite: $sprite_ts > local: $local_ts)"
  else
    echo "  Kept local: $(basename $dest) (local is newer or equal)"
  fi
}

if [ -d "$EXTRACT_DIR/$SPRITE_SLUG" ]; then
  echo "Remapping slug: $SPRITE_SLUG -> -$LOCAL_SLUG"
  LOCAL_PROJECTS="$HOME/.claude/projects"
  mkdir -p "$LOCAL_PROJECTS/-$LOCAL_SLUG"
  for f in "$EXTRACT_DIR/$SPRITE_SLUG/"*.jsonl; do
    [ -f "$f" ] || continue
    fname=$(basename "$f")
    dest="$LOCAL_PROJECTS/$LOCAL_SLUG/$fname"
    merge_jsonl "$f" "$dest"
  done
  echo "Sessions merged into $LOCAL_PROJECTS/-$LOCAL_SLUG/"
else
  echo "Warning: Expected slug folder $SPRITE_SLUG not found in extracted archive"
  ls "$EXTRACT_DIR/" 2>/dev/null || echo "Extract dir contents unavailable"
fi

# Cleanup
rm -rf /tmp/osborn-sessions.tar.gz /tmp/osborn-extract
echo "Done. Local sessions updated."
\`\`\`

Then execute: \`bash /tmp/osborn-download.sh\`

### After running
Verify by checking that \`~/.claude/projects/<your-local-slug>/\` contains the expected \`.jsonl\` files from the cloud session.

### Notes
- Merge uses JSONL timestamps — the version with the most recent session entry wins, regardless of file size or modification time
- The cloud instance exports its full \`~/.claude/projects/\` directory as a gzip tar
- Slug remapping is handled by the script — cloud instance slug becomes your local slug
- If you have multiple project slugs on the cloud instance, the script picks up all of them
`

  return new NextResponse(skillContent, {
    headers: {
      'Content-Type': 'text/markdown',
      'Content-Disposition': 'attachment; filename="SKILL.md"',
    },
  })
}
