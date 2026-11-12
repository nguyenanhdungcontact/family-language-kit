"""
Every day, for every language: find new videos for the topics in video/<lang>/sources.json, keep the
ones that really have subtitles in that language, prepare their phrases, and ADD them to
docs/data/<lang>/video/catalog.json. Old videos are never removed.

Steps:
  1. Catch up: prepare phrases for catalog videos that still have none (a few per run).
  2. Hand-picked videos (video/<lang>/picks.json) are added first.
  3. Candidates from the YouTube Data API: newest uploads of the listed channels (very cheap)
     + a few topic searches (rotating every day).
  4. Filter on video details: embeddable, public, right language, min..max minutes, landscape.
  5. Fetch subtitles + prepare phrases, one by one, until target_per_day videos PASSED today.
     Videos that fail are remembered in video/<lang>/state.json so they are not tried again.
  6. Write the catalog, the subtitle files (captions/) and the badge index (phrases/index.json).

    python scripts/video_daily.py            every language in video/languages.json
    python scripts/video_daily.py zh         only Chinese

Environment:
  YOUTUBE_API_KEY    YouTube Data API v3 key (finding new videos; without it only step 1 runs)
  GEMINI_API_KEY / ANTHROPIC_API_KEY, AI_PROVIDER   as in scripts/video_phrases.py
  TARGET_PER_DAY, MAX_SEARCHES   optional overrides of the numbers in sources.json (handy for the first run)
"""
import datetime as dt
import json
import os
import pathlib
import re
import sys
import time

import requests

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import video_phrases as vp  # noqa: E402

ROOT = vp.ROOT
YT_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
TODAY = dt.date.today().isoformat()
PAUSE = 4          # seconds between two subtitle fetches, so YouTube does not block the IP


class QuotaExceeded(Exception):
    pass


def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save(path, data, indent=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=indent), encoding="utf-8")


# ------------------------------------------------------------------ YouTube Data API
def yt(path, **params):
    params["key"] = YT_KEY
    r = requests.get(f"https://www.googleapis.com/youtube/v3/{path}", params=params, timeout=30)
    if r.status_code == 403 and "quota" in r.text.lower():
        raise QuotaExceeded()
    if r.status_code != 200:
        raise RuntimeError(f"YouTube API {path} HTTP {r.status_code}: {r.text[:200]}")
    return r.json()


def channel_id(handle, state):
    """'@name' or 'name' → UC… id (1 quota unit, remembered in state.json). A UC… id is returned as is."""
    handle = handle.strip().lstrip("@")
    if re.fullmatch(r"UC[\w-]{22}", handle):
        return handle
    known = state.setdefault("channels", {})
    if handle not in known:
        items = yt("channels", part="id", forHandle="@" + handle).get("items", [])
        known[handle] = items[0]["id"] if items else ""
        if not items:
            print(f"  ! No YouTube channel with the handle @{handle} (check video/{vp.LANG}/sources.json)")
    return known[handle]


def channel_uploads(cid, n):
    """Newest videos of a channel. The uploads playlist of channel UCxxx is UUxxx (1 quota unit)."""
    data = yt("playlistItems", part="contentDetails", playlistId="UU" + cid[2:], maxResults=n)
    return [i["contentDetails"]["videoId"] for i in data.get("items", [])]


def search(query, days, with_cc=True):
    after = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
    data = yt("search", part="id", type="video", q=query, maxResults=25, order="relevance",
              videoEmbeddable="true", videoCaption="closedCaption" if with_cc else "any", videoDuration="medium",
              relevanceLanguage=vp.L.get("search_lang", vp.LANG), safeSearch="strict", publishedAfter=after)
    return [i["id"]["videoId"] for i in data.get("items", []) if i.get("id", {}).get("videoId")]


def details(ids):
    out = {}
    for i in range(0, len(ids), 50):
        data = yt("videos", part="snippet,contentDetails,status,player", maxWidth=1280,
                  id=",".join(ids[i:i + 50]))
        for it in data.get("items", []):
            out[it["id"]] = it
    return out


def seconds(iso):
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return 0
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def clock(sec):
    h, rem = divmod(int(sec), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def reject_reason(item, cfg, row=None, picked=False):
    """A row may set its own min_minutes / max_minutes (travel vlogs are usually longer)."""
    if row:
        cfg = dict(cfg, **{k: row[k] for k in ("min_minutes", "max_minutes") if k in row})
    sn, st, cd = item.get("snippet", {}), item.get("status", {}), item.get("contentDetails", {})
    dur = seconds(cd.get("duration"))
    if not st.get("embeddable", False):
        return "embedding not allowed"
    if st.get("privacyStatus") != "public":
        return "not public"
    if sn.get("liveBroadcastContent", "none") != "none":
        return "live broadcast"
    if picked:
        return None                                   # hand-picked: you chose it, length and language are your call
    if dur < cfg["min_minutes"] * 60:
        return "too short"
    if dur > cfg["max_minutes"] * 60:
        return "too long"
    lang = (sn.get("defaultAudioLanguage") or "").lower()
    if lang and not lang.startswith(tuple(vp.L.get("audio_prefixes") or [vp.LANG])):
        return f"spoken language is {lang}"
    if "#shorts" in (sn.get("title", "") + sn.get("description", "")[:300]).lower():
        return "Shorts"
    pl = item.get("player", {})
    try:
        w, h = float(pl.get("embedWidth", 0)), float(pl.get("embedHeight", 0))
    except (TypeError, ValueError):
        w = h = 0
    if w and h and w / h < 1.3:
        return "upright video"
    return None


# ------------------------------------------------------------------ Finding candidates
def find_candidates(cfg, skip, state):
    """List of (video_id, row_id), rows interleaved by weight so the content stays varied."""
    doy = dt.date.today().timetuple().tm_yday
    per_row = {r["id"]: [] for r in cfg["rows"]}
    for row in cfg["rows"]:
        chans = row.get("channels") or []
        for handle in (list(chans.values()) if isinstance(chans, dict) else chans):
            try:
                cid = channel_id(handle, state)
                if cid:
                    per_row[row["id"]] += channel_uploads(cid, int(cfg.get("uploads_per_channel", 10)))
            except QuotaExceeded:
                raise
            except Exception as e:
                print(f"  ! Channel @{handle}: {e}")

    # A few searches per day, rotating by date so every day covers another topic
    plan = []
    rows_q = [r for r in cfg["rows"] if r.get("queries")]
    for k in range(max((len(r["queries"]) for r in rows_q), default=0)):
        for row in rows_q:
            q = row["queries"][(doy + k) % len(row["queries"])]
            if (row["id"], q) not in plan:
                plan.append((row["id"], q))
    budget = int(os.environ.get("MAX_SEARCHES") or cfg["max_searches_per_day"])
    for row_id, q in plan:
        if budget <= 0:
            break
        try:
            found = search(q, int(cfg["search_recent_days"]))
            budget -= 1
            if len(found) < 6 and budget > 0:        # few videos with hand-made subtitles: also allow auto-subtitles
                found += [v for v in search(q, int(cfg["search_recent_days"]), with_cc=False) if v not in found]
                budget -= 1
            per_row[row_id] += found
            print(f"  Search [{row_id}] “{q}”: {len(found)} results")
        except QuotaExceeded:
            raise
        except Exception as e:
            print(f"  ! Search “{q}”: {e}")

    queues, used = [], set(skip)
    for row in cfg["rows"]:
        q = []
        for vid in per_row.get(row["id"], []):
            if vid not in used:
                used.add(vid)
                q.append((vid, row["id"]))
        if q:
            queues.append([max(1, int(row.get("weight", 1))), q])
    return interleave(queues)


def interleave(queues):
    """[[weight, [items…]], …] → one list, taking `weight` items from each queue in turn."""
    mixed = []
    while queues:
        for entry in list(queues):
            for _ in range(entry[0]):
                if entry[1]:
                    mixed.append(entry[1].pop(0))
            if not entry[1]:
                queues.remove(entry)
    return mixed


# ------------------------------------------------------------------ One video
def make_phrases(vid):
    """Fetch subtitles + prepare phrases, save the file. Raises video_phrases errors when it cannot."""
    old = load(vp.OUT_DIR / f"{vid}.json", {})
    if old.get("phrases") and len(old["phrases"]) >= 4:
        return old                    # prepared in an earlier (interrupted) run: reuse, no second AI call
    tr = vp.get_transcript(vid)
    if len(tr["segments"]) < 15:
        raise vp.NoCaptions()
    out = vp.build(vid, tr)
    if len(out["phrases"]) < 4:
        raise vp.NoCaptions()
    save(vp.OUT_DIR / f"{vid}.json", out)
    return out


def phrase_info(vid):
    d = load(vp.OUT_DIR / f"{vid}.json", {})
    if d.get("phrases"):
        return {"n": len(d["phrases"]), "level": d.get("level", "")}
    return None


def run_language(code) -> int:
    vp.set_lang(code)
    sources, state_file = ROOT / "video" / code / "sources.json", ROOT / "video" / code / "state.json"
    cfg = load(sources, None)
    if not cfg:
        print(f"[{code}] Cannot read {sources}")
        return 1
    print(f"\n===== {vp.L['name']} ({code}) =====", flush=True)

    catalog = load(vp.CATALOG, {"rows": [], "videos": []})
    catalog.setdefault("videos", [])
    state = load(state_file, {})
    rejected = state.setdefault("rejected", {})
    retries = state.setdefault("retries", {})
    days = state.setdefault("added_per_day", {})
    by_id = {v["id"]: v for v in catalog["videos"]}
    added_today = int(days.get(TODAY, 0))
    target = max(0, int(os.environ.get("TARGET_PER_DAY") or cfg["target_per_day"]) - added_today)
    added = 0
    ai_busy = 0
    stop = None
    no_caps = f"no usable {vp.L['name']} subtitles"

    def attempt(vid):
        """The result when the video passes, None otherwise. Raises vp.Blocked when YouTube blocks the IP."""
        nonlocal ai_busy
        try:
            out = make_phrases(vid)
            ai_busy = 0
            retries.pop(vid, None)
            print(f"    ✓ {len(out['phrases'])} phrases, {out['source'].split('-')[-1]} subtitles", flush=True)
            return out
        except vp.Blocked:
            raise
        except vp.NoCaptions:
            rejected[vid] = no_caps
            print(f"    ✗ {no_caps}", flush=True)
        except vp.Temporary as e:
            ai_busy += 1
            print(f"    … {e}. Next time.", flush=True)
        except vp.CouldNotRetrieveTranscript as e:
            rejected[vid] = f"could not fetch subtitles ({type(e).__name__})"
            print(f"    ✗ could not fetch subtitles ({type(e).__name__})", flush=True)
        except Exception as e:
            retries[vid] = retries.get(vid, 0) + 1
            if retries[vid] >= 2:
                rejected[vid] = f"error: {str(e)[:120]}"
            print(f"    ! error: {str(e)[:160]}", flush=True)
        return None

    def add(vid, row_id, item, out):
        nonlocal added
        sn = item["snippet"]
        entry = {
            "id": vid, "row": row_id, "title": sn["title"],
            "channel": sn.get("channelTitle", ""),
            "dur": clock(seconds(item["contentDetails"]["duration"])),
            "added": TODAY, "published": sn.get("publishedAt", "")[:10],
            "level": out.get("level", ""), "n": len(out["phrases"]),
        }
        catalog["videos"].append(entry)
        by_id[vid] = entry
        added += 1
        days[TODAY] = added_today + added
        save(vp.CATALOG, catalog)            # save at once: an interrupted run keeps the finished videos
        save(state_file, state)

    try:
        # 1) Catch up on catalog videos without phrases
        backlog = [v for v in catalog["videos"] if not phrase_info(v["id"]) and v["id"] not in rejected]
        if backlog:
            n = min(int(cfg.get("backfill_per_run", 4)), len(backlog))
            print(f"Catching up on older videos: {n}/{len(backlog)}", flush=True)
            for v in backlog[:n]:
                print(f"  → {v['id']} {v['title'][:70]}", flush=True)
                attempt(v["id"])
                time.sleep(PAUSE)

        if not YT_KEY:
            print("No YOUTUBE_API_KEY, so the search for new videos is skipped.")
        else:
            rows_by_id = {r["id"]: r for r in cfg["rows"]}
            # 2) Hand-picked videos
            picks = load(vp.PICKS_FILE, {})
            pick_ids = [v for v in picks.get("videos", []) if v not in by_id and v not in rejected]
            if pick_ids:
                pick_row = picks.get("row") if picks.get("row") in rows_by_id else cfg["rows"][0]["id"]
                info = details(pick_ids)
                for vid in pick_ids:
                    item = info.get(vid)
                    why = "not found on YouTube" if not item else reject_reason(item, cfg, picked=True)
                    print(f"  → [picked] {vid} {(item or {}).get('snippet', {}).get('title', '')[:70]}", flush=True)
                    if why:
                        rejected[vid] = why
                        print(f"    ✗ {why}")
                        continue
                    out = attempt(vid)
                    if out:
                        add(vid, pick_row, item, out)
                    time.sleep(PAUSE)

            # 3-5) Find and add new videos
            if target - added <= 0:
                print(f"Today's {added_today + added} videos are already in. More tomorrow.")
            else:
                print(f"Looking for new videos ({target - added} more wanted today)…", flush=True)
                cands = find_candidates(cfg, set(by_id) | set(rejected), state)
                info = details([c[0] for c in cands][:300])
                per = {}
                for vid, row_id in cands:
                    item = info.get(vid)
                    if not item:
                        continue
                    why = reject_reason(item, cfg, rows_by_id.get(row_id))
                    if why:
                        rejected[vid] = why
                        continue
                    per.setdefault(row_id, []).append((vid, row_id, item))
                print("Passed the filter, per row: " + ", ".join(f"{r} {len(q)}" for r, q in per.items()), flush=True)
                # Interleave the rows (by weight) AFTER filtering, so every topic gets new videos
                ok = interleave([[max(1, int(rows_by_id[r].get("weight", 1))), q] for r, q in per.items()])
                print(f"{len(cands)} candidates, {len(ok)} passed the filter. Fetching subtitles…", flush=True)
                tried = 0
                for vid, row_id, item in ok:
                    if added >= target or tried >= int(cfg["max_transcript_tries"]):
                        break
                    if ai_busy >= 1:
                        stop = "the AI is busy or today's free allowance is used up"
                        break
                    tried += 1
                    print(f"  → [{row_id}] {vid} {item['snippet']['title'][:70]}", flush=True)
                    out = attempt(vid)
                    if out:
                        add(vid, row_id, item, out)
                    time.sleep(PAUSE)
    except vp.Blocked as e:
        stop = f"YouTube is blocking this IP for subtitles ({e})"
    except QuotaExceeded:
        stop = "today's YouTube Data API quota is used up"

    # 6) Refresh the phrase info for the whole catalog, write the files
    for v in catalog["videos"]:
        pi = phrase_info(v["id"])
        v["n"] = pi["n"] if pi else 0
        if pi:
            v["level"] = pi["level"]
    rows_cfg = [{"id": r["id"], "title": r["title"]} for r in cfg["rows"]]
    known = {r["id"] for r in rows_cfg}
    extra = [r for r in catalog.get("rows", []) if r["id"] not in known
             and any(v["row"] == r["id"] for v in catalog["videos"])]
    catalog["rows"] = rows_cfg + extra
    catalog["updated"] = TODAY
    days[TODAY] = added_today + added
    for d in sorted(days)[:-30]:
        days.pop(d)
    save(vp.CATALOG, catalog)
    save(state_file, state)
    vp.write_captions()
    vp.write_index()

    total = len(catalog["videos"])
    ready = sum(1 for v in catalog["videos"] if v["n"])
    print(f"[{code}] Added {added} new video(s) today (day total {days[TODAY]}). "
          f"Catalog: {total} videos, {ready} with phrases.")
    if stop:
        print(f"Stopped early: {stop}.")
    return 0


def main() -> int:
    if not vp.ai_key():
        print(f"Missing the AI key for AI_PROVIDER={vp.PROVIDER} (GEMINI_API_KEY or ANTHROPIC_API_KEY).")
        return 1
    codes = [a for a in sys.argv[1:] if not a.startswith("-")] or vp.LANG_CODES
    rc = 0
    for code in codes:
        rc = max(rc, run_language(code))
    return rc


if __name__ == "__main__":
    sys.exit(main())
