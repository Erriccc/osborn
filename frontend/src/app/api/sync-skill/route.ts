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

4. Build the compressed archive
   (If no files are newer, you can skip the upload entirely.)

   Choose compression based on what's available on your system:

   Best option — zstd (if installed):
   Linux/Codespace: sudo apt-get install -y zstd  (if not present), then:
     tar --zstd -cf /tmp/osborn-sync.tar.zst -C ~/.claude/projects -- <slug>/<file1> <slug>/<file2> ...
   Mac: brew install zstd  (if not present), then same command above.

   Universal fallback — gzip at max compression (always available):
     GZIP=-9 tar -czf /tmp/osborn-sync.tar.gz -C ~/.claude/projects -- <slug>/<file1> <slug>/<file2> ...

   Windows (PowerShell):
     Compress-Archive -Path "$env:USERPROFILE\\.claude\\projects\\<slug>" -DestinationPath "$env:TEMP\\osborn-sync.zip" -CompressionLevel Optimal
     Note: update the upload curl command in step 5 to use osborn-sync.zip as the filename.

   Why these choices: zstd and gzip produce similar-sized archives for JSON text, but zstd
   compresses 5-10x faster. At max gzip level (-9), you get 10-20% smaller archives than
   default gzip with no additional install. Use whichever gets you the smallest file fastest
   on your system. The server auto-detects compression format, so any of these formats will
   work on the receiving end.

5. Upload to the sprite
   curl -X POST "<SPRITE_URL>/sessions/import?targetWorkDir=<URL_ENCODED_TARGET_PATH>" \\
     -H "Authorization: Bearer <TOKEN>" \\
     -H "Content-Type: application/octet-stream" \\
     --data-binary @/tmp/osborn-sync.tar.gz
   If you used zstd, change the filename to @/tmp/osborn-sync.tar.zst.
   If you used Windows PowerShell, change the filename to @"$env:TEMP\\osborn-sync.zip".
   You can run this in the background with \`&\` so you are not blocked waiting for the upload to complete.

   **Faster option — parallel chunk upload:**
   This splits the archive into 50MB chunks and uploads them simultaneously.

   # Generate unique upload ID
   UPLOAD_ID=$(date +%s%N | md5sum | head -c 16)

   # Split archive into 50MB chunks
   mkdir -p /tmp/osborn-chunks
   split -b 50m /tmp/osborn-sync.tar.gz /tmp/osborn-chunks/chunk-
   CHUNKS=($( ls /tmp/osborn-chunks/chunk-* | sort))
   TOTAL=\${#CHUNKS[@]}

   # Upload all chunks in parallel
   for i in "\${!CHUNKS[@]}"; do
     curl -X POST "<SPRITE_URL>/sessions/import-chunk?uploadId=$UPLOAD_ID&chunk=$i" \\
       -H "Authorization: Bearer <TOKEN>" \\
       -H "Content-Type: application/octet-stream" \\
       --data-binary @"\${CHUNKS[$i]}" &
   done
   wait

   # Finalize (reassemble and extract on sprite)
   curl -X POST "<SPRITE_URL>/sessions/import-finalize?uploadId=$UPLOAD_ID&total=$TOTAL&targetWorkDir=<URL_ENCODED_TARGET_PATH>" \\
     -H "Authorization: Bearer <TOKEN>"

   # Clean up chunks
   rm -rf /tmp/osborn-chunks

6. Confirm success
   Response should contain "ok":true

7. After 60–90 seconds, verify by fetching the manifest again and confirming your files appear:
   curl -s "<SPRITE_URL>/sessions/manifest" | grep <slug>

8. Clean up
   rm /tmp/osborn-sync.tar.gz /tmp/osborn-manifest.json
   (If you used zstd: rm /tmp/osborn-sync.tar.zst /tmp/osborn-manifest.json)
   (If you used Windows: del "$env:TEMP\\osborn-sync.zip")
`

  return new NextResponse(skillContent, {
    headers: {
      'Content-Type': 'text/markdown',
      'Content-Disposition': 'attachment; filename="SKILL.md"',
    },
  })
}
