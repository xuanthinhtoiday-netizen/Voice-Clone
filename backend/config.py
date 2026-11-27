from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
VOICES_DIR = DATA_DIR / "voices"
OUTPUTS_DIR = DATA_DIR / "outputs"
MODELS_DIR = DATA_DIR / "models"
TEMP_DIR = DATA_DIR / "temp"
HISTORY_FILE = DATA_DIR / "history.json"
VOICES_META_FILE = VOICES_DIR / "voices_meta.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"


def load_settings() -> dict:
    import json

    if not SETTINGS_FILE.exists():
        return {"hf_token": ""}
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"hf_token": ""}


def save_settings(data: dict) -> dict:
    import json

    cur = load_settings()
    cur.update(data)
    SETTINGS_FILE.write_text(json.dumps(cur, ensure_ascii=False, indent=2), encoding="utf-8")
    return cur


def get_hf_token() -> str | None:
    tok = (load_settings().get("hf_token") or os.getenv("HF_TOKEN") or "").strip()
    return tok or None

for _d in (DATA_DIR, VOICES_DIR, OUTPUTS_DIR, MODELS_DIR, TEMP_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def get_ffmpeg_path() -> str | None:
    """Resolve ffmpeg binary from PATH or bundled imageio-ffmpeg."""
    import shutil

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        pass
    return None
