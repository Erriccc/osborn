#!/bin/bash
# Osborn — Fly.io Deploy Script
# Usage: ./deploy.sh <app-name> [region]
# Example: ./deploy.sh osborn-agent-john iad
#
# Prerequisites:
#   1. flyctl installed (curl -L https://fly.io/install.sh | sh)
#   2. fly auth login
#   3. API keys ready (LIVEKIT, ANTHROPIC, GOOGLE, DEEPGRAM)

set -e

APP_NAME=${1:-"osborn-agent"}
REGION=${2:-"iad"}

echo "🚀 Deploying Osborn to Fly.io as: $APP_NAME (region: $REGION)"
echo ""

# 1. Create app (no deploy yet)
echo "📦 Creating Fly app..."
fly launch --name "$APP_NAME" --region "$REGION" --no-deploy --yes

# 2. Create persistent workspace volume
echo "💾 Creating persistent volume (5GB)..."
fly volumes create workspace --size 5 --region "$REGION" --app "$APP_NAME" --yes

# 3. Set secrets
echo ""
echo "🔑 Setting API keys..."
echo "   Required: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET"
echo "   Required: DEEPGRAM_API_KEY"
echo "   Optional: ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY"
echo ""

if [ -z "$LIVEKIT_URL" ]; then
  echo "⚠️  Set environment variables before running, or pass them inline:"
  echo "   LIVEKIT_URL=wss://... LIVEKIT_API_KEY=... ./deploy.sh $APP_NAME"
  echo ""
  echo "   Or set them manually after deploy:"
  echo "   fly secrets set LIVEKIT_URL=wss://... --app $APP_NAME"
  echo ""
else
  fly secrets set \
    LIVEKIT_URL="$LIVEKIT_URL" \
    LIVEKIT_API_KEY="$LIVEKIT_API_KEY" \
    LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
    DEEPGRAM_API_KEY="$DEEPGRAM_API_KEY" \
    ${ANTHROPIC_API_KEY:+ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"} \
    ${GOOGLE_API_KEY:+GOOGLE_API_KEY="$GOOGLE_API_KEY"} \
    ${OPENAI_API_KEY:+OPENAI_API_KEY="$OPENAI_API_KEY"} \
    --app "$APP_NAME"
fi

# 4. Deploy
echo ""
echo "🏗️  Building and deploying..."
fly deploy --app "$APP_NAME"

echo ""
echo "✅ Deployed! Your Osborn agent is live at: https://$APP_NAME.fly.dev"
echo ""
echo "Next steps:"
echo "  1. Open https://osborn.app"
echo "  2. Enter the room code shown in: fly logs --app $APP_NAME"
echo "  3. On first connect, authenticate Claude via the login link"
echo ""
echo "Useful commands:"
echo "  fly logs --app $APP_NAME          # Watch agent logs"
echo "  fly ssh console --app $APP_NAME   # SSH into the container"
echo "  fly secrets set KEY=val --app $APP_NAME  # Add/update secrets"
