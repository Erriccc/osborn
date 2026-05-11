import { NextResponse } from 'next/server'

export async function GET() {
  const skillContent = `# Osborn Sync — Push sessions to your Osborn sprite

## What this does
Syncs your local Claude Code session files to your Osborn sprite. Uses incremental sync: only uploads files newer than what the sprite already has.

## Variables (fill these in from your "Copy sync info" button)
- SPRITE_URL: your sprite's base URL
- TOKEN: your auth token
- TARGET_PATH: the working directory path on the sprite (URL-encoded in the curl command)

## Steps

1. Compute your local slug
   Your slug is your current working directory path with "/" replaced by "-".
   Example: /Users/alice/Developer/myproject → -Users-alice-Developer-myproject

2. Fetch the manifest (what the sprite already has)
   curl -s "<SPRITE_URL>/sessions/manifest" > /tmp/osborn-manifest.json

3. Identify files to upload
   Compare mtime of each .jsonl file in ~/.claude/projects/<slug>/ against the manifest.
   Only include files where local mtime > remote mtime, or files not in the manifest at all.
   On first sync (slug not in manifest), include all files.

4. Build the tar with only changed files
   tar -czf /tmp/osborn-sync.tar.gz -C ~/.claude/projects -- <slug>/<file1> <slug>/<file2> ...
   (If no files are newer, you can skip the upload entirely.)
   Note: on Linux/Codespace, zstd gives better compression — use GNU tar's --zstd flag:
     tar --zstd -cf /tmp/osborn-sync.tar.zst -C ~/.claude/projects -- <slug>/<file1> <slug>/<file2> ...
   Then update the curl filename in step 5 to @/tmp/osborn-sync.tar.zst
   On Mac, gzip (as shown above) works fine; for zstd support install GNU tar via Homebrew (brew install gnu-tar).

5. Upload to the sprite
   curl -X POST "<SPRITE_URL>/sessions/import?targetWorkDir=<URL_ENCODED_TARGET_PATH>" \\
     -H "Authorization: Bearer <TOKEN>" \\
     -H "Content-Type: application/octet-stream" \\
     --data-binary @/tmp/osborn-sync.tar.gz
   You can run this in the background with \`&\` so you are not blocked waiting for the upload to complete.

6. Confirm success
   Response should contain "ok":true

7. After 60–90 seconds, verify by fetching the manifest again and confirming your files appear:
   curl -s "<SPRITE_URL>/sessions/manifest" | grep <slug>

8. Clean up
   rm /tmp/osborn-sync.tar.gz /tmp/osborn-manifest.json
`

  return new NextResponse(skillContent, {
    headers: {
      'Content-Type': 'text/markdown',
      'Content-Disposition': 'attachment; filename="SKILL.md"',
    },
  })
}
