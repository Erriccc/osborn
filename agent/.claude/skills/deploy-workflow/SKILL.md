---
name: deploy-workflow
description: The end-to-end release procedure for shipping osborn agent changes — build and verify locally, bump the package.json version, push to GitHub, publish to NPM from the Mac, and update the running Sprite from the registry. Use every time code or prompt changes are ready to ship.
---

# Deploy Workflow

Use this every time changes are ready to ship.

## Steps

1. Build and verify locally
   - `cd /home/sprite/workspace/osborn/agent && npm run build`
   - Confirm dist/prompts/ has the updated files (no nesting)

2. Bump version in package.json
   - Patch bump for prompt/config changes (0.8.x → 0.8.x+1)
   - Minor bump for new features (0.8.x → 0.9.0)

3. Push to GitHub
   - `git add` the specific changed files
   - `git commit -m "descriptive message"`
   - `git push origin main`

4. User publishes to NPM from Mac
   - User runs `git pull` on their Mac
   - User runs `cd agent && npm publish` from the osborn repo

5. Update the Sprite from the NPM registry
   - `npm install -g osborn`
   - Do NOT use `npm install -g .` — that installs from local build, not registry
   - Verify: `npm list -g osborn` should show the expected version

6. Confirm
   - Check the running version matches what was published
   - grep the osborn-sprite.log for the version if needed

## Dev iteration (no npm)
To try an unreleased build on one Fly machine without publishing:
`cd frontend && npx tsx scripts/fly-dev-install.ts <fly-app> [ref, default HEAD] --yes`
(needs FLY_API_TOKEN, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in `frontend/.env.local`).
It packs `agent/` at that commit under the version the machine already reports, installs it on the volume and restarts; `/workspace/.osborn-dev-build` records what is installed.
Rollback: the dashboard Update button or the next release image swaps it out once the version changes. To drop it before then at the same version, delete `/workspace/.npm-global/lib/node_modules/osborn` on the machine and restart; the entrypoint reinstalls the image's version from npm.
Dev only: real releases still go through the steps above.

## Why this order matters
Installing from the registry (step 5) ensures the Sprite runs exactly what anyone else would install — not a local build that may differ from what was published. Local builds are for development only.
