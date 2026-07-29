# Skill: YouTube Transcript

Fetch and save transcripts from YouTube videos.

## When to use
When the user asks to get a transcript, subtitles, captions, or summary from a YouTube video URL.

## How to execute

yt-dlp is installed on this system. Use this exact command:

```bash
yt-dlp --skip-download --write-auto-sub --sub-lang en --convert-subs srt -o "/tmp/yt-%(id)s" "<VIDEO_URL>"
```

This downloads auto-generated English subtitles as an SRT file to /tmp/yt-{video-id}.en.srt

Then read the SRT file and strip the timing markers to get clean transcript text.

## Output
Save the cleaned transcript to the session workspace as `library/youtube-{video-id}-transcript.md` with:
- Video title and URL at the top
- Cleaned transcript text (strip SRT timing markers and duplicate lines)
- Key timestamps preserved as section markers if meaningful breaks exist
