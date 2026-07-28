# The voice-E2E engine, fully containerized — this is exactly what a Fly
# tester machine would run. Bundled Chromium (headless), API TTS for the
# mouth, element-tap ears, Stagehand brain. No local Chrome, no macOS.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /e2e
COPY package.json ./
RUN npm install
# npm may resolve a newer Playwright than the image's preinstalled browsers —
# install the matching Chromium build for whatever version we got.
RUN npx playwright install chromium
COPY playwright.config.ts ./
COPY lib ./lib
COPY specs ./specs
COPY fixtures ./fixtures
COPY scripts ./scripts
COPY scenarios ./scenarios

ARG HARNESS_SHA=dev
ENV HARNESS_SHA=$HARNESS_SHA
ENV OSBORN_TEST_CONTAINER=1
# Keys at runtime: -e OPENAI_API_KEY -e GOOGLE_API_KEY -e DEEPGRAM_API_KEY
# (on Fly these come from `fly secrets`). OSBORN_TEST_SPEC picks the spec.
CMD ["sh", "scripts/fly-run.sh"]
