"""
Every day, add a few new words per language to docs/data/<lang>/words.json (the words that fly on
the TV dashboard and appear in the games). The AI teacher writes them; the topic rotates daily
through "word_topics" in video/languages.json.

    python scripts/words_daily.py            every language
    python scripts/words_daily.py vi --force also when today's words were already added

Environment: GEMINI_API_KEY / ANTHROPIC_API_KEY, AI_PROVIDER (as in video_phrases.py),
             WORDS_PER_DAY (default 5)
"""
import datetime as dt
import json
import pathlib
import os
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import video_phrases as vp  # noqa: E402

ROOT = vp.ROOT
TODAY = dt.date.today().isoformat()
PER_DAY = int(os.environ.get("WORDS_PER_DAY") or 5)
FIELDS = {"w": "string", "pron": "string", "pos": "string", "en": "string", "ex": "string", "ex_en": "string"}

PROMPT = """You are a warm {name} teacher. Your students: {learner}

Give {n} NEW {brief}. Today's topic: "{topic}".
They must NOT be any of these, which the students already have:
{have}

For each word give:
- w: the word or short phrase in {name}
- pron: {pron_rule}
- pos: noun, verb, adj, adv, phrase or idiom
- en: short English meaning
- ex: one short, natural example sentence in {name}
- ex_en: English translation of the example
{extra}"""


def schema(upper):
    T = (lambda t: t.upper()) if upper else (lambda t: t)
    return {"type": T("object"), "required": ["words"], "properties": {"words": {"type": T("array"), "items": {
        "type": T("object"), "required": list(FIELDS), "properties": {k: {"type": T(v)} for k, v in FIELDS.items()}}}}}


def run_language(code, force=False) -> int:
    vp.set_lang(code)
    path = ROOT / "docs" / "data" / code / "words.json"
    words = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    if not force and any(o.get("added") == TODAY for o in words):
        print(f"[{code}] Today's words are already in.")
        return 0
    topics = vp.L.get("word_topics") or ["everyday life"]
    topic = topics[dt.date.today().timetuple().tm_yday % len(topics)]
    have = {vp._norm(o["w"]) for o in words}
    prompt = PROMPT.format(name=vp.L["name"], learner=vp.L["learner"], n=PER_DAY + 3, brief=vp.L.get("words_brief", "useful everyday words"),
                           topic=topic, have=", ".join(o["w"] for o in words[-400:]) or "(none yet)",
                           pron_rule=vp.L["pron_rule"], extra=vp.L.get("extra_rule", ""))
    try:
        result = vp.ask_ai(prompt, schema(True), schema(False))
    except vp.Temporary as e:
        print(f"[{code}] {e}. Next time.")
        return 0
    new = []
    for o in result.get("words", []):
        w = (o.get("w") or "").strip()
        if not w or not (o.get("en") or "").strip() or vp._norm(w) in have:
            continue
        have.add(vp._norm(w))
        new.append({k: (o.get(k) or "").strip() for k in FIELDS} | {"added": TODAY})
        if len(new) >= PER_DAY:
            break
    if not new:
        print(f"[{code}] The AI gave no new words today.")
        return 0
    words += new
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("[\n" + ",\n".join(json.dumps(o, ensure_ascii=False) for o in words) + "\n]\n", encoding="utf-8")
    print(f"[{code}] +{len(new)} words on “{topic}” ({len(words)} total): " + ", ".join(o["w"] for o in new))
    return 0


def main() -> int:
    if not vp.ai_key():
        print(f"Missing the AI key for AI_PROVIDER={vp.PROVIDER} (GEMINI_API_KEY or ANTHROPIC_API_KEY).")
        return 1
    force = "--force" in sys.argv
    codes = [a for a in sys.argv[1:] if not a.startswith("-")] or vp.LANG_CODES
    for code in codes:
        try:
            run_language(code, force)
        except Exception as e:                      # one language failing must not stop the others
            print(f"[{code}] words: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
