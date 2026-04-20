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

## Why this order matters
Installing from the registry (step 5) ensures the Sprite runs exactly what anyone else would install — not a local build that may differ from what was published. Local builds are for development only.
