# Notes for AI helpers (Claude Code, Antigravity, Codex, …)

You are helping a **non-programmer family** run their copy of the Family Language Kit. Do the work for them, explain in plain English, one step at a time. The human-facing instructions are in `docs/guide.html` (nine steps); follow the same order when they ask to "set it up".

## What this project is

A static website in `docs/` (served by GitHub Pages from `main` / `/docs`) plus Python scripts that add content every day. No build step, no framework, no npm. Open `docs/*.html` directly or serve the folder:

```bash
python3 -m http.server 8771 --directory docs     # then http://localhost:8771
```

- Languages being learned are keyed by code (`zh`, `vi`). The explanation language is English.
- `docs/config.js` is the only file a family must edit (family name, `syncDb`, `syncCode`, languages).
- Every page loads `config.js` then `learn-core.js`. The current language comes from `?lang=xx` or `localStorage['learn.lang']`; content is read from `docs/data/<lang>/`.
- Word shape (`docs/data/<lang>/words.json`): `{ "w": word, "pron": pinyin or respelling, "pos", "en": English meaning, "ex": example in the language, "ex_en": its translation, "added"?: "YYYY-MM-DD" }`.
- Phrase shape (`docs/data/<lang>/video/phrases/<id>.json`): `{ summary, level, phrases: [{ t, d, phrase, pron, quote, meaning, usage, example, example_pron, example_en }] }`. `t` is always a real subtitle start time; never invent times.
- Sync is plain REST to Firebase Realtime Database at `/sync/<syncCode>-<lang>/{flags,words}` (see `docs/learn-core.js`, rules in `video/firebase-rules.json`).

## Common requests and how to do them

| They say | You do |
| --- | --- |
| "Set up my keys" | Create `.env.local` with `GEMINI_API_KEY=` and `YOUTUBE_API_KEY=` and let them paste the values themselves. Never print, log or commit keys. `.env.local` is in `.gitignore`. |
| "Run the daily update" | macOS/Linux: `./scripts/run_local.sh`. Windows: `scripts\run_local.bat`. One language: add `zh` or `vi`. It commits and pushes by itself. |
| "Schedule it" | macOS: `./scripts/install_daily_mac.sh [HH:MM]`. Windows: `schtasks /create /tn "Family Language Kit" /tr "<full path>\scripts\run_local.bat" /sc daily /st 06:30`. |
| "Use our own sync" | Put their Firebase URL in `syncDb` and a new random 20+ character code (a-z, 0-9, dashes) in `syncCode` in `docs/config.js`. The Firebase rules are in `video/firebase-rules.json`. |
| "Change who is learning" | Edit `learner` (and labels) in `video/languages.json`, `who` in `docs/config.js`. |
| "More / different videos" | Edit `video/<lang>/sources.json`: `channels` are YouTube handles without `@`; `queries` are search phrases. Single videos go into `video/<lang>/picks.json`. |
| "Add words" | Append to `docs/data/<lang>/words.json` in the shape above (accurate tone marks / accents matter). |
| "Add a language" | Add it to `docs/config.js` (`languages`), `video/languages.json`, create `video/<code>/sources.json` + `picks.json` and `docs/data/<code>/words.json` (about 60 starter words), then run `python scripts/daily.py <code>`. Pages need no changes. |
| "Use Claude instead of Gemini" | `.env.local`: `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY=`. In GitHub: secret `ANTHROPIC_API_KEY`, variable `AI_PROVIDER=claude`. |
| "Build the TV app" | GitHub › Actions › "Build the TV app (APK)" › Run workflow. The APK appears at `releases/latest/download/family-language-tv.apk`. |

## Rules of the road

- Keep the site static and dependency-free. Pages must keep working on a TV WebView (remote keys: arrows, Enter, Back) and on phones.
- After changing a page, check it at phone width (375px) and at 1920×1080 for the TV pages; run `node --check` on changed `.js` files.
- Videos are for children too: keep `safeSearch=strict` in `scripts/video_daily.py` and only add kid-appropriate channels to the Chinese sources.
- The free Gemini tier allows about 20 requests per day per model. Do not raise `target_per_day` far above 6 per language without telling the family why it may stall.
- Never commit `.env.local`, `.cache/` or `.venv/`. Never put real names, emails or anything private into the repo: it is public.
- Commit small, with plain-English messages; push to `main` (GitHub Pages redeploys in about a minute).
