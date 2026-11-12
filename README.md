# Family Language Kit

A little language corner for one family: **Chinese (中文) for the kids, Vietnamese (Tiếng Việt) for Dad**, taught in English.

| Screen | What it does | File |
| --- | --- | --- |
| **TV meteor shower** | Words drift across the TV all day; every 15 seconds one lights up with its meaning and an example | `docs/tv.html` |
| **TV channel** | Real YouTube videos with subtitles and a list of useful phrases, driven by the TV remote | `docs/video.html` |
| **Phone & iPad videos** | The same videos in your pocket: tap a phrase to hear that moment, ☆ to save it | `docs/iphone.html`, `docs/ipad.html` |
| **Word asteroids / Word bricks** | Two casual games built from the same word list | `docs/game.html`, `docs/bricks.html` |

Saved ★ words sync between every device and fly on the TV. A small daily job finds new videos and asks an AI teacher (Gemini or Claude) for phrases and new words.

**Live demo:** https://nguyenanhdungcontact.github.io/family-language-kit/
**Setup guide (start here):** https://nguyenanhdungcontact.github.io/family-language-kit/guide.html

## Make it yours in two clicks

1. Press **Use this template › Create a new repository** (keep it Public).
2. In your copy: **Settings › Pages › Deploy from a branch › `main` / `/docs` › Save**.

Your site is then at `https://<your-name>.github.io/<your-copy>/`. The [setup guide](docs/guide.html) covers the rest (your own keys, private sync, the TV app) in nine small steps, and an AI helper such as Claude Code or Antigravity can do most of it for you: it reads [AGENTS.md](AGENTS.md).

## What lives where

```
docs/                 the website (GitHub Pages serves this folder)
  config.js           the ONE file a family edits: family name, sync, languages
  index.html          start page: pick a language, pick a screen
  tv.html video.html iphone.html ipad.html game.html bricks.html
  learn-core.js       shared: language, sync, catalog, helpers
  learn-app.js        logic of the phone + iPad pages
  guide.html share.html
  data/<lang>/words.json            words for the TV shower and the games
  data/<lang>/video/catalog.json    the video rows
  data/<lang>/video/phrases/        phrases per video (made by the AI teacher)
  data/<lang>/video/captions/       subtitle lines per video
video/
  languages.json      who the learners are, how the AI teacher should explain
  <lang>/sources.json topics, channels and search phrases per language
  <lang>/picks.json   hand-picked videos
  firebase-rules.json rules to paste into Firebase (sync)
scripts/
  daily.py            the whole daily update in one command
  video_daily.py      finds videos, fetches subtitles, prepares phrases
  video_phrases.py    the AI teacher (Gemini or Claude)
  words_daily.py      five new words per language per day
  run_local.sh / run_local.bat / install_daily_mac.sh
app/                  tiny Android TV app (a full-screen WebView on tv.html)
.github/workflows/    daily update + TV app build
```

## The daily update

```bash
# keys live in .env.local (never committed):  GEMINI_API_KEY=...  YOUTUBE_API_KEY=...
./scripts/run_local.sh            # macOS / Linux
scripts\run_local.bat             # Windows
./scripts/install_daily_mac.sh    # macOS: run it every morning at 6:30
```

YouTube usually refuses to give subtitles to cloud servers, so new **videos** are prepared on a home computer; the GitHub Actions job adds new **words** either way.

Everything runs on free plans: GitHub Pages and Actions, the Gemini API free tier (about 20 requests a day per model; the scripts fall back to the next model), the YouTube Data API (10,000 units a day) and Firebase Realtime Database.

## Credits

Built as a birthday gift, with Claude Code. Videos stay on YouTube and belong to their creators; this kit only links to them and stores short phrases for study.
