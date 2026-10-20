# Ambient-source memory for a transcript-level noise gate — research brief (Oct 2026)

> Produced by a deep-research agent 2026-10-20. Companion to `noise-gate-research-2026-10.md`.
> Question: what is the gate's new ambient-memory layer called in industry/academia, and
> what standards/tools exist to borrow?

## 1. What the detection/tracking layer is called

Audio-level academia splits this into three DCASE-community tasks (DCASE 2016 outcome paper; cross-task baselines 2019, arxiv.org/pdf/1904.03476):

- **Acoustic Scene Classification (ASC)** — one label for the whole environment ("home", "street").
- **Audio tagging** — which sound classes are present ("music", "TV", "speech"), no timestamps. Closest audio analog of our ambient tag.
- **Sound Event Detection (SED)** — tags *plus* onset/offset times.

The transcript-level version has **no canonical standalone name**. Nearest research frame: the *text modality of false-trigger mitigation / device-directed speech detection* — Apple's LLM-based DDSD classifies ASR **text** (plus confidences) to reject "background speech and TV/media audio" (arxiv.org/html/2403.14438v1; machinelearning.apple.com/research/on-device-false-trigger). Inferring *what the media is* from transcript text exists as MIR research ("lyrics transcription" — ISMIR 2021 cover detection, ISMIR 2025 AI-song detection) but not as an assistant layer.

**For osborn:** call it "transcript-level audio tagging" / a **media & background-speech rejection head with ambient-source memory**. Use audio-tagging class vocabulary (music, TV, lecture, speech) so a future audio-level tagger drops in without renaming.

## 2. How production assistants handle media/background audio

- **Amazon/Alexa** — **acoustic fingerprinting of known media**: on-device fingerprint sets for currently-airing ads + cloud matching of wake audio against a fingerprint DB; ≥2 devices sending matching audio simultaneously ⇒ inferred broadcast, fingerprints built dynamically (amazon.science blog Jan 2019; patent US10475449 "Wake-word detection suppression"). ("Media wake suppression" is NOT a verified official term; published terms are acoustic fingerprinting / wake-word suppression.)
- **Apple/Siri** — publishes **False Trigger Mitigation (FTM)**: LSTM acoustic FTM, streaming-transformer FTM, parallel out-of-domain LM (Bi-LRNN 2020), "Siri directed speech detection". No published media-fingerprint system.
- **Google** — nothing published; mitigation is **Voice Match** (speaker verification), sensitivity sliders, "Hey Google, that wasn't for you". TV-ad false fires remain a live complaint.
- **Sonos** — patents on deactivating wake-word engines when the device itself plays audio containing the wake word (US10878811) — self-playback, solved via AEC/known-content metadata.

**For osborn:** incumbents use *fingerprints of known content* (needs a content DB) or *speaker verification*. Nobody published a transcript-level media classifier — ours is the cheap third path the LLM era enables; Apple's 2024 LLM-DDSD paper is the direct precedent. Lightweight speaker-ID is the proven complementary signal.

## 3. Audio fingerprinting vs. lyrics-text lookup

- **Chromaprint/AcoustID** (open source, free non-commercial): matches whole tracks only, not short ambient snippets — disqualifying here.
- **Commercial realtime:** ACRCloud (sub-second, 100M+ tracks, sales-gated pricing), AudD (public pricing, streaming API), Audible Magic (enterprise compliance market).
- **ShazamKit** (Apple): `SHSession.matchStreamingBuffer`/`SHManagedSession` continuous matching, free with a developer account — Apple platforms only (iOS 18 background-mode regression noted).
- **Lyrics-text lookup:** Musixmatch `track.search` with `q_lyrics` (search by lyric snippet) — ⚠️ parameter needs docs-level verification before building; free tier is ~30% previews. **Genius API cannot search lyric text** (metadata search only, no lyrics in API). Caveat: ASR mangles sung lyrics (Whisper hallucinates on music) — snippet lookup is fuzzy.

**For osborn:** fingerprinting is gold-standard but audio-level, catalog-bound, and costs money (except ShazamKit, Mac-local only). A Musixmatch `q_lyrics` call is a viable cheap *verification* step fired only when the classifier already suspects music — confidence boost, not ground truth.

## 4. Importable tools for ambient sound context

- **YAMNet** (Google, TF/TFLite): 521 AudioSet classes incl. Music/Television/Speech; realtime on CPU/edge.
- **PANNs** (CNN14, 527 classes, mAP 0.439): heavier, more accurate, `pip install panns-inference`.
- **CLAP** (LAION / Microsoft): zero-shot text-prompted audio classification — classify against OUR label set ("movie dialogue", "lecture") with no training.
- **Apple SoundAnalysis**: `SNClassifySoundRequest` v1, 303 built-in classes, macOS 12+/iOS 15+ on-device — Apple-platform only; a LiveKit/server pipeline can't use it. Server-side equivalents = YAMNet/PANNs/CLAP over the LiveKit PCM frames we already have.
- Silero = VAD only; openWakeWord = wake words only — neither does tagging.

**For osborn:** when graduating to audio-level corroboration, run **YAMNet (cheap) or CLAP (custom labels)** server-side on the LiveKit audio — a "Music/Television present" probability per 1-second window is exactly what the ambient memory wants, near-zero cost.

## 5. The "rolling ambient context fed back into the classifier prompt" pattern

No single canonical name. Components:

- **Context/slot carryover** — Alexa's term, but it means *dialogue* entity carryover, not environment state (don't reuse).
- **Dialogue state tracking (DST)** — the academic frame for "persist inferred state across turns, condition on it."
- **Context-aware proactive agents** — ContextAgent (arxiv 2505.14668, May 2025) feeds continuous wearable sensory context into LLM prompts; closest published shape.
- **Agent-memory vocabulary** — a TTL cache like ours is a classic **scratchpad / working memory / blackboard** (Always-On Agents survey, arxiv 2606.30306).
- **Shipped:** Limitless Pendant (ambient capture → searchable memory; Meta acquisition Dec 2025 — secondary sources only), Friend necklace. Neither publishes an ambient-source-tagging mechanism.

**For osborn:** internally: **ambient context cache** ("environmental state tracking"); in docs: dialogue-state-style context carryover applied to environment rather than dialogue. Nothing standard exists to import here — this part is legitimately ours.

## 6. Bottom line

The transcript-level ambient memory is **aligned with where the field is heading, not behind it** — Apple's 2024 direction is LLMs over ASR text for exactly this rejection problem; the incumbent alternative (fingerprint DBs) is infrastructure-heavy and catalog-bound. Naming: gate = *device-directed speech detection / false-trigger mitigation*; new layer = *transcript-level audio tagging with an ambient context cache*, AudioSet/DCASE class names for tags. Import priority when ready: **(1) YAMNet or CLAP server-side on LiveKit audio** (cheapest, catalog-free, corroborates every tag type); (2) Musixmatch `q_lyrics` as optional per-suspicion lyrics verifier; (3) fingerprinting (ShazamKit/ACRCloud) only if we ever need to know *which* song/show — the gate doesn't.

**Flagged unverifiable:** "media wake suppression" as an official Amazon term; Musixmatch `q_lyrics` parameter; ACRCloud/Audible Magic pricing; Meta-Limitless acquisition date.
