"""
Prepare study phrases for each video from the subtitles YouTube already has.

1. Fetch the transcript with youtube-transcript-api: subtitles made by the channel (manual) first,
   auto-generated ones otherwise, in the language being learned. No such subtitles → skip the video.
   Text, start and duration of every line are kept exactly as YouTube gives them.
2. Keep the raw transcript in .cache/transcripts/<lang>/ (NOT committed) so it is fetched only once.
3. The AI only works on text: it picks phrases, meanings, examples and a level. It answers with the
   LINE NUMBER that contains each phrase; this script takes the start time of that line from the
   transcript. The AI never invents a time.
4. The repo stores docs/data/<lang>/video/phrases/<id>.json (phrase, the short line it is in, start,
   duration) and docs/data/<lang>/video/captions/<id>.json (the subtitle lines the pages draw).

Languages are described in video/languages.json. Pick one with set_lang("zh") or run:
    python scripts/video_phrases.py zh        (all languages when no code is given)

Environment:
  AI_PROVIDER        gemini (default) or claude
  GEMINI_API_KEY     needed when AI_PROVIDER=gemini
  GEMINI_MODEL       one model, or several separated by commas, tried in order. The free tier gives
                     each model about 20 requests a day; when one runs out the next takes over.
                     Default: gemini-3.6-flash,gemini-3.7-flash,gemini-3.5-flash,gemini-3.5-flash-lite
  ANTHROPIC_API_KEY  needed when AI_PROVIDER=claude
  CLAUDE_MODEL       default claude-haiku-5-5
  MAX_PER_RUN        most videos per run, default 10
"""
import json
import os
import pathlib
import re
import sys
import time
import unicodedata

import requests
from youtube_transcript_api import (
    YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled, VideoUnavailable,
    RequestBlocked, CouldNotRetrieveTranscript,
)

ROOT = pathlib.Path(__file__).resolve().parent.parent
LANGUAGES = json.loads((ROOT / "video" / "languages.json").read_text(encoding="utf-8"))
LANG_CODES = [k for k in LANGUAGES if not k.startswith("_")]

PROVIDER = (os.environ.get("AI_PROVIDER") or "gemini").strip().lower()
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODELS = [m.strip() for m in (os.environ.get("GEMINI_MODEL") or
                 "gemini-3.6-flash,gemini-3.7-flash,gemini-3.5-flash,gemini-3.5-flash-lite").split(",") if m.strip()]
GEMINI_MODEL = GEMINI_MODELS[0]          # the model that answered last (written into each phrases file)
CLAUDE_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
CLAUDE_MODEL = (os.environ.get("CLAUDE_MODEL") or "claude-haiku-5-5").strip()
MAX_PER_RUN = int(os.environ.get("MAX_PER_RUN") or 10)

# Set by set_lang()
LANG = None            # "zh", "vi", …
L = {}                 # that language's entry in video/languages.json
PICKS_FILE = OUT_DIR = CAP_DIR = CACHE_DIR = CATALOG = None


def set_lang(code: str):
    """Point every path at one language."""
    global LANG, L, PICKS_FILE, OUT_DIR, CAP_DIR, CACHE_DIR, CATALOG
    if code not in LANG_CODES:
        raise SystemExit(f"Unknown language '{code}'. video/languages.json has: {', '.join(LANG_CODES)}")
    LANG, L = code, LANGUAGES[code]
    PICKS_FILE = ROOT / "video" / code / "picks.json"
    OUT_DIR = ROOT / "docs" / "data" / code / "video" / "phrases"
    CAP_DIR = ROOT / "docs" / "data" / code / "video" / "captions"
    CATALOG = ROOT / "docs" / "data" / code / "video" / "catalog.json"
    CACHE_DIR = ROOT / ".cache" / "transcripts" / code


class Blocked(Exception):
    """YouTube is blocking this IP (common on cloud servers). Stop the whole run."""


class NoCaptions(Exception):
    """The video has no usable subtitles in the language being learned."""


class Temporary(Exception):
    """The AI service is busy: save nothing, try again next run."""


def ai_key() -> str:
    return GEMINI_KEY if PROVIDER == "gemini" else CLAUDE_KEY


# ------------------------------------------------------------------ 1-2. Transcript
class _TimeoutSession(requests.Session):
    """Every request to YouTube waits 30 seconds at most (no hanging for hours on a dropped connection)."""
    def request(self, *args, **kwargs):
        kwargs.setdefault("timeout", 30)
        return super().request(*args, **kwargs)


def _http():
    s = _TimeoutSession()
    s.headers.update({"Accept-Language": "en-US,en;q=0.9"})
    return s


def _find_track(tlist):
    codes = L["caption_codes"]
    try:
        return tlist.find_manually_created_transcript(codes)
    except NoTranscriptFound:
        return tlist.find_generated_transcript(codes)


def get_transcript(video_id: str) -> dict:
    cache = CACHE_DIR / f"{video_id}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))

    api = YouTubeTranscriptApi(http_client=_http())
    try:
        tr = _find_track(api.list(video_id))
        lang_code = tr.language_code
        fetched = tr.fetch()
    except RequestBlocked as e:          # includes IpBlocked
        raise Blocked(str(e).splitlines()[0] if str(e) else "RequestBlocked")
    except (NoTranscriptFound, TranscriptsDisabled, VideoUnavailable):
        raise NoCaptions()

    # Optional: Traditional → Simplified Chinese ("convert_from" / "convert_to" in video/languages.json; needs the opencc package)
    convert = None
    if L.get("convert_to") == "zh-Hans" and lang_code.startswith(tuple(L.get("convert_from") or ())):
        try:
            from opencc import OpenCC
            convert, lang_code = OpenCC("t2s").convert, "zh-Hans"
        except Exception:
            print("    (opencc is not installed: subtitles stay in Traditional characters)")

    segments = []
    for s in fetched.to_raw_data():
        text = re.sub(r"\s+", " ", (s.get("text") or "").replace("\n", " ")).strip()
        if convert:
            text = convert(text)
        if text and not re.fullmatch(r"[\[（(【].{0,12}[\]）)】]", text):      # drop [Music] / （音乐） lines
            segments.append({"text": text, "start": s["start"], "duration": s.get("duration", 0)})
    data = {
        "id": video_id,
        "language": lang_code,
        "kind": "auto" if tr.is_generated else "manual",
        "segments": segments,
    }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


# ------------------------------------------------------------------ 3. The AI only works on text
PROMPT = """You are a warm, encouraging {name} teacher. Your students: {learner}
They speak English, so explain everything in simple, friendly English.

Below is the subtitle text of a {name} video. Each line starts with [n] = the line number.{note}

<subtitles>
{lines}
</subtitles>

Choose 8 to 12 useful, natural {name} words or short phrases that appear in these lines: everyday words, set phrases and little chunks the students could reuse at home, at school, with friends, when eating or travelling. Prefer common expressions; skip names of people and anything rare or technical. Spread them across the whole video.
Copy each phrase EXACTLY as it is written in its subtitle line (same characters and spelling), so it can be found in that line. {phrase_rule}

For each one give:
- n: the line number where it appears (if it spans two lines, the first of them)
- phrase: the word or phrase, exactly as in the line
- pron: {pron_rule}
- meaning: short English meaning
- usage: one short, friendly English note on when and how to use it
- example: one NEW short {name} example sentence, not from the video
- example_pron: {example_pron_rule}
- example_en: English translation of the example
Also give summary (what the video is about, 2 short English sentences) and level ({level_rule}).
{extra}
Do not invent times. Only refer to line numbers."""

PHRASE_PROPS = {
    "n": "integer", "phrase": "string", "pron": "string", "meaning": "string", "usage": "string",
    "example": "string", "example_pron": "string", "example_en": "string",
}


def _schema(upper: bool) -> dict:
    T = (lambda t: t.upper()) if upper else (lambda t: t)
    return {
        "type": T("object"),
        "properties": {
            "summary": {"type": T("string")},
            "level": {"type": T("string")},
            "phrases": {"type": T("array"), "items": {
                "type": T("object"),
                "properties": {k: {"type": T(v)} for k, v in PHRASE_PROPS.items()},
                "required": list(PHRASE_PROPS),
            }},
        },
        "required": ["summary", "level", "phrases"],
    }


_gemini_used_up = set()        # models whose free daily allowance is finished (for this run)


def ask_gemini(prompt: str, schema: dict = None) -> dict:
    """Tries the models in GEMINI_MODEL in order. The free tier gives every model its own small daily
    allowance (about 20 requests), so when one is used up the next model takes over."""
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema or _schema(True)},
    }
    global GEMINI_MODEL
    for model in GEMINI_MODELS:
        if model in _gemini_used_up:
            continue
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        r = None
        for attempt in range(3):
            try:
                r = requests.post(url, headers={"x-goog-api-key": GEMINI_KEY}, json=body, timeout=150)
            except requests.exceptions.RequestException as e:
                raise Temporary(f"Gemini did not answer in time ({type(e).__name__})")
            if r.status_code == 429 and "per day" in r.text.lower():
                break                                   # today's allowance for this model is gone
            if r.status_code in (429, 500, 502, 503, 504):
                print(f"    … {model} answered {r.status_code}, waiting {20 * (attempt + 1)}s", flush=True)
                time.sleep(20 * (attempt + 1))
                continue
            break
        if r.status_code in (404, 429):
            why = "is not available" if r.status_code == 404 else "has used up today's free allowance"
            print(f"    … {model} {why}, trying the next model", flush=True)
            _gemini_used_up.add(model)
            continue
        if r.status_code in (500, 502, 503, 504):
            raise Temporary(f"Gemini is busy ({r.status_code})")
        if r.status_code != 200:
            raise RuntimeError(f"Gemini HTTP {r.status_code}: {r.text[:400]}")
        GEMINI_MODEL = model
        cand = (r.json().get("candidates") or [{}])[0]
        try:
            return json.loads(cand["content"]["parts"][0]["text"])
        except (KeyError, IndexError, json.JSONDecodeError):
            raise RuntimeError(f"Gemini returned something odd: finishReason={cand.get('finishReason')}")
    raise Temporary("every Gemini model in GEMINI_MODEL has used up today's free allowance")


def ask_claude(prompt: str, schema: dict = None) -> dict:
    tool = {"name": "save_result", "description": "Save the result.", "input_schema": schema or _schema(False)}
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": CLAUDE_MODEL, "max_tokens": 12000, "tools": [tool],
              "tool_choice": {"type": "tool", "name": "save_result"},
              "messages": [{"role": "user", "content": prompt}]},
        timeout=300,
    )
    if r.status_code in (429, 500, 529):
        raise Temporary(f"Claude is busy ({r.status_code})")
    if r.status_code != 200:
        raise RuntimeError(f"Claude HTTP {r.status_code}: {r.text[:400]}")
    for b in r.json().get("content", []):
        if b.get("type") == "tool_use":
            return b.get("input", {})
    raise RuntimeError("Claude returned no result")


def ask_ai(prompt: str, gemini_schema: dict = None, claude_schema: dict = None) -> dict:
    return ask_gemini(prompt, gemini_schema) if PROVIDER == "gemini" else ask_claude(prompt, claude_schema)


# ------------------------------------------------------------------ Tie each phrase to its real subtitle line
_CJK = re.compile(r"[㐀-鿿豈-﫿]")


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "").lower()


def _tokens(s: str) -> list:
    """Chinese: one token per character. Spaced languages: one token per word (accents kept)."""
    s = _norm(s)
    if L.get("cjk"):
        return _CJK.findall(s)
    return re.findall(r"[^\W_]+", s, re.UNICODE)


def _score(phrase: str, text: str) -> float:
    pt, tt = _tokens(phrase), _tokens(text)
    if not pt or not tt:
        return 0.0
    n = len(pt)
    if any(tt[i:i + n] == pt for i in range(len(tt) - n + 1)):
        return 1.0                                   # the whole phrase, in order
    return 0.8 * sum(1 for t in pt if t in tt) / n     # partly there


def locate(phrase: str, n: int, segs: list):
    """Find the line that really contains the phrase, near the line the AI named.
    Returns (segment index, quote) or None."""
    best = None
    for j in range(max(0, n - 5), min(len(segs), n + 6)):
        one = segs[j]["text"]
        two = one + (" " if not L.get("cjk") else "") + segs[j + 1]["text"] if j + 1 < len(segs) else one
        s1, s2 = _score(phrase, one), _score(phrase, two)
        cand = (s1, j, one) if s1 >= s2 else (s2 - 0.01, j, two)
        key = (round(cand[0], 2), -abs(j - n))        # best score first, then nearest to the AI's line
        if best is None or key > best[0]:
            best = (key, cand)
    if not best or best[1][0] < 0.6:
        return None
    _, j, quote = best[1]
    if L.get("cjk"):
        return j, quote[:40] + ("…" if len(quote) > 40 else "")
    words = quote.split()
    return j, " ".join(words[:25]) + ("…" if len(words) > 25 else "")


def build(video_id: str, tr: dict) -> dict:
    segs = tr["segments"]
    lines = "\n".join(f"[{i}] {s['text']}" for i, s in enumerate(segs))
    note = ("" if tr["kind"] == "manual" else
            "\nThese are auto-generated subtitles: punctuation may be missing, lines may cut sentences, and a few words may be misheard.")
    prompt = PROMPT.format(
        name=L["name"], learner=L["learner"], lines=lines, note=note,
        phrase_rule=L.get("phrase_rule", ""), pron_rule=L["pron_rule"],
        example_pron_rule=L.get("example_pron_rule", "empty string"),
        level_rule=L["level_rule"], extra=L.get("extra_rule", ""),
    )
    result = ask_ai(prompt)

    phrases, seen = [], set()
    for p in result.get("phrases", []):
        try:
            n = int(p.get("n"))
        except (TypeError, ValueError):
            continue
        phrase = (p.get("phrase") or "").strip()
        hit = locate(phrase, n, segs)
        if not phrase or not hit or _norm(phrase) in seen:
            continue
        j, quote = hit
        seen.add(_norm(phrase))
        phrases.append({
            "t": round(segs[j]["start"], 2),          # straight from the YouTube subtitle
            "d": round(segs[j]["duration"], 2),
            "phrase": phrase, "pron": p.get("pron", ""), "quote": quote,
            "meaning": p.get("meaning", ""), "usage": p.get("usage", ""),
            "example": p.get("example", ""), "example_pron": p.get("example_pron", ""),
            "example_en": p.get("example_en", ""),
        })
    phrases.sort(key=lambda x: x["t"])
    return {
        "id": video_id, "created": time.strftime("%Y-%m-%d"),
        "source": f"youtube-{tr['kind']}", "language": tr["language"],
        "ai": GEMINI_MODEL if PROVIDER == "gemini" else CLAUDE_MODEL,
        "summary": result.get("summary", ""), "level": result.get("level", ""),
        "phrases": phrases,
    }


# ------------------------------------------------------------------ Run
def needs_work(vid: str) -> bool:
    f = OUT_DIR / f"{vid}.json"
    if not f.exists():
        return True
    try:
        old = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return True
    if old.get("error") == "no_captions":
        return False
    return bool(old.get("error"))


def video_ids() -> list:
    """Hand-picked videos (video/<lang>/picks.json) first, then every video in the catalog."""
    ids = []
    if PICKS_FILE.exists():
        ids = list(json.loads(PICKS_FILE.read_text(encoding="utf-8")).get("videos", []))
    if CATALOG.exists():
        try:
            vids = json.loads(CATALOG.read_text(encoding="utf-8")).get("videos", [])
        except Exception:
            vids = []
        for v in vids:
            if v["id"] not in ids:
                ids.append(v["id"])
    return ids


def write_captions():
    """docs/data/<lang>/video/captions/<id>.json: the subtitle lines the pages draw under the video
    (YouTube's embedded player does not show subtitles reliably). Only for videos that have phrases."""
    CAP_DIR.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in OUT_DIR.glob("*.json"):
        if f.name == "index.json":
            continue
        vid = f.stem
        cache = CACHE_DIR / f"{vid}.json"
        out = CAP_DIR / f"{vid}.json"
        if not cache.exists() or out.exists():
            continue
        tr = json.loads(cache.read_text(encoding="utf-8"))
        segs = [[round(x["start"], 2), round(x.get("duration") or 0, 2), x["text"]] for x in tr["segments"]]
        out.write_text(json.dumps({"id": vid, "kind": tr.get("kind", ""), "s": segs}, ensure_ascii=False,
                                  separators=(",", ":")), encoding="utf-8")
        n += 1
    if n:
        print(f"Wrote subtitles for {n} video(s).")


def write_index():
    """docs/data/<lang>/video/phrases/index.json: which videos have phrases (the Aa badge on video cards)."""
    idx = {}
    for f in sorted(OUT_DIR.glob("*.json")):
        if f.name == "index.json":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("phrases"):
            idx[d.get("id", f.stem)] = {"n": len(d["phrases"]), "level": d.get("level", "")}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "index.json").write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")


def run_one_language() -> int:
    ids = video_ids()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    todo = [v for v in ids if needs_work(v)]
    print(f"[{LANG}] AI: {PROVIDER}. {len(ids)} videos, {len(todo)} need phrases, at most {MAX_PER_RUN} this run.", flush=True)

    done, blocked = 0, False
    for vid in todo[:MAX_PER_RUN]:
        print(f"→ {vid}", flush=True)
        try:
            tr = get_transcript(vid)
            print(f"  Subtitles {tr['kind']} ({tr['language']}): {len(tr['segments'])} lines", flush=True)
            out = build(vid, tr)
            print(f"  Phrases: {len(out['phrases'])}", flush=True)
        except Blocked as e:
            print(f"  YouTube is blocking this computer's IP: {e}")
            print("  Run the script on a home computer instead (scripts/run_local.sh), then commit the result.")
            blocked = True
            break
        except NoCaptions:
            print(f"  No {L['name']} subtitles, skipped.")
            out = {"id": vid, "created": time.strftime("%Y-%m-%d"), "error": "no_captions", "phrases": []}
        except Temporary as e:
            print(f"  {e}. Will try again next run.")
            continue
        except CouldNotRetrieveTranscript as e:
            print(f"  Could not fetch subtitles: {type(e).__name__}. Will try again next run.")
            continue
        except Exception as e:
            print(f"  Error: {e}")
            out = {"id": vid, "created": time.strftime("%Y-%m-%d"), "error": str(e)[:300], "phrases": []}
        (OUT_DIR / f"{vid}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        done += 1
        time.sleep(3)

    write_index()
    write_captions()
    print(f"[{LANG}] Done: {done} video(s).")
    return 2 if blocked and done == 0 else 0


def main() -> int:
    if not ai_key():
        print(f"Missing the key for AI_PROVIDER={PROVIDER}. Set GEMINI_API_KEY or ANTHROPIC_API_KEY.")
        return 1
    codes = [a for a in sys.argv[1:] if not a.startswith("-")] or LANG_CODES
    rc = 0
    for code in codes:
        set_lang(code)
        rc = max(rc, run_one_language())
    return rc


if __name__ == "__main__":
    sys.exit(main())
