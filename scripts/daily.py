"""
The whole daily update in one command (works on macOS, Windows and Linux):

    python scripts/daily.py              new videos + phrases + new words, then commit and push
    python scripts/daily.py --no-git     only update the files (GitHub Actions commits by itself)
    python scripts/daily.py zh           one language only

Keys are read from .env.local in the project folder (never committed, see .gitignore):
    GEMINI_API_KEY=...          (or ANTHROPIC_API_KEY=... together with AI_PROVIDER=claude)
    YOUTUBE_API_KEY=...
"""
import os
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_env():
    f = ROOT / ".env.local"
    if not f.exists():
        return
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def git(*args, check=False):
    return subprocess.run(["git", *args], cwd=ROOT, check=check, capture_output=True, text=True)


def main() -> int:
    load_env()
    args = sys.argv[1:]
    use_git = "--no-git" not in args and (ROOT / ".git").exists()
    langs = [a for a in args if not a.startswith("-")]
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")):
        print("No AI key found. Create .env.local with GEMINI_API_KEY=... (see the setup guide, step 4).")
        return 1
    if use_git:
        git("pull", "--rebase", "--autostash")
    print(f"== {time.strftime('%d %b %H:%M')} New videos and phrases ==", flush=True)
    subprocess.run([sys.executable, "-u", str(ROOT / "scripts" / "video_daily.py"), *langs], cwd=ROOT)
    print("== New words ==", flush=True)
    subprocess.run([sys.executable, "-u", str(ROOT / "scripts" / "words_daily.py"), *langs], cwd=ROOT)
    if not use_git:
        return 0
    git("add", "docs/data", "video")
    if git("diff", "--cached", "--quiet").returncode == 0:
        print("Nothing new to save.")
        return 0
    git("commit", "-q", "-m", f"Daily update {time.strftime('%Y-%m-%d')}: new videos, phrases and words")
    for _ in range(3):
        if git("pull", "--rebase", "--autostash").returncode == 0 and git("push").returncode == 0:
            print("Pushed to GitHub. The site updates in about a minute.")
            return 0
        time.sleep(10)
    print("Could not push to GitHub right now; the next run will push it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
