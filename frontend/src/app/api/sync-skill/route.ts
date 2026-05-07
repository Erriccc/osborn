import { NextResponse } from 'next/server'

export async function GET() {
  const skillContent = `# Osborn Sync — Push sessions to your Osborn sprite

Use this skill to sync your current project sessions to your Osborn voice interface.

## What you need
Before running this skill, have ready:
- Your Osborn sprite URL (from your Osborn dashboard)
- Your Osborn sync token (from your Osborn dashboard)
- Your target project path on the sprite (e.g. /home/sprite/workspace/myproject)

## Steps

1. Identify the current project slug. Take your current working directory path and replace every \`/\` with \`-\`. Example: \`/home/codespace/myproject\` → \`-home-codespace-myproject\`.

2. Locate the session files at \`~/.claude/projects/<slug>/\`.

3. Create a tar archive:
   \`tar -czf /tmp/osborn-sync.tar.gz -C ~/.claude/projects <slug>\`

4. Push to your sprite (replace the placeholders with your actual values):
   \`curl -s -X POST "<YOUR_SPRITE_URL>/sessions/import?targetWorkDir=<URL_ENCODED_TARGET_PATH>" -H "Authorization: Bearer <YOUR_TOKEN>" -H "Content-Type: application/octet-stream" --data-binary @/tmp/osborn-sync.tar.gz\`

5. Confirm \`"ok":true\` in the response. Done.

6. Clean up: \`rm /tmp/osborn-sync.tar.gz\`
`

  return new NextResponse(skillContent, {
    headers: {
      'Content-Type': 'text/markdown',
      'Content-Disposition': 'attachment; filename="SKILL.md"',
    },
  })
}
