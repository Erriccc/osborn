import { NextResponse } from 'next/server'

export async function GET() {
  const skillContent = `# Osborn Session Sync Skill

## WHEN TO USE
When the user wants to sync their local Claude Code session files to their Osborn sprite for backup or migration. This makes session memory available across devices.

## WHAT YOU NEED
From the Osborn dashboard (voice-native.com), copy the sync info block which gives you three values:
- SPRITE_URL (e.g. https://osborn-abc123.sprites.app)
- TOKEN (your sync token)
- TARGET_PATH (e.g. /home/sprite/workspace)

## HOW TO EXECUTE — IMPORTANT: Use a sub-agent with auto-approve

Delegate the entire sync to a sub-agent. Do NOT run individual tool calls interactively — that forces the user to approve every curl and bash call. Instead, write a single shell script and execute it in one step so only one permission approval is needed.

### Step 1 — Get the manifest
Fetch the current state of what's already on the sprite:
curl -s -H "Authorization: Bearer $TOKEN" "$SPRITE_URL/sessions/manifest"

### Step 2 — Write a sync script to /tmp/osborn-sync.sh

Write the complete script as a single file, then execute it. The script should:

1. Set the three variables (SPRITE_URL, TOKEN, TARGET_PATH)
2. Determine the local slug: the current Claude projects directory path with / replaced by -
   - Local projects dir is typically: $HOME/.claude/projects
   - Slug example: -Users-yourname-Desktop-Developer-osborn
3. Create a gzip archive — ALWAYS use gzip, NOT zstd (server doesn't support zstd):
   cd ~/.claude/projects && tar -czf /tmp/osborn-sync.tar.gz --exclude='._*' -- <slug>/*.jsonl
   Note: --exclude='._*' is required on macOS to prevent BSD tar AppleDouble metadata files
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
       "$SPRITE_URL/sessions/import-chunk?uploadId=$UPLOAD_ID&chunkIndex=<n>" &
   wait  # wait for all parallel uploads to complete
7. Finalize — assembles all chunks and extracts:
   curl -s -X POST \\
     -H "Authorization: Bearer $TOKEN" \\
     "$SPRITE_URL/sessions/import-finalize?uploadId=$UPLOAD_ID&targetWorkDir=$TARGET_PATH"
8. Verify — fetch manifest again and confirm slug appears:
   curl -s -H "Authorization: Bearer $TOKEN" "$SPRITE_URL/sessions/manifest"

### Step 3 — Execute the script
Run: bash /tmp/osborn-sync.sh

### Step 4 — Report results
After the script finishes, report: how many files were uploaded, whether the manifest shows the slug, and any errors.

## TECHNICAL NOTES
- Server auto-detects gzip vs plain tar via zlib stream sniffing (v0.9.15+) — no Content-Type header needed
- Always use gzip (-czf). Never use zstd — server does not support it
- Parallel chunked upload: all chunks return HTTP 200 independently; finalize assembles them
- Slug remapping is automatic: your local slug is remapped to the sprite's target path
- The sync is safe to re-run: existing files are not overwritten (no-overwrite behavior)
- BSD tar on macOS: always use --exclude='._*' to prevent AppleDouble metadata files in the archive
`

  return new NextResponse(skillContent, {
    headers: {
      'Content-Type': 'text/markdown',
      'Content-Disposition': 'attachment; filename="SKILL.md"',
    },
  })
}
