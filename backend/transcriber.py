from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from backend.config import TEMP_DIR

_WHISPER_LOCK = threading.Lock()
_WHISPER_MODEL: Any = None


def _get_whisper():
    global _WHISPER_MODEL
    with _WHISPER_LOCK:
        if _WHISPER_MODEL is None:
            from faster_whisper import WhisperModel

            # 'small' int8 on CPU is super accurate for Vietnamese tones and ~240MB
            _WHISPER_MODEL = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=2)
        return _WHISPER_MODEL


def extract_clean_prompt_clip(
    ref_audio_path: Path,
    target_sec: float = 5.5,
    max_sec: float = 6.8,
) -> Path:
    """
    Cut a clean ~5.0–6.5s reference clip ending at a natural low-energy pause
    so prompt audio never cuts mid-syllable, with a 100ms silence pad at the end.
    """
    cache_path = TEMP_DIR / f"prompt6_{ref_audio_path.stem}_{ref_audio_path.stat().st_mtime_ns}.wav"
    if cache_path.exists():
        return cache_path

    wav, sr = sf.read(str(ref_audio_path), dtype="float32", always_2d=False)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)

    max_samples = int(sr * max_sec)
    if len(wav) <= max_samples:
        clip = wav
    else:
        # Search for quietest 80ms pause between 4.0s and max_sec to end cleanly on a word/sentence boundary
        win = max(1, int(sr * 0.08))
        search_start = int(sr * 4.0)
        search_end = min(len(wav) - win, max_samples)
        best_pos = int(sr * target_sec)
        best_e = float("inf")
        step = max(1, int(sr * 0.04))
        for pos in range(search_start, search_end, step):
            seg = wav[pos : pos + win]
            e = float(np.mean(seg * seg))
            if e < best_e:
                best_e = e
                best_pos = pos + win // 2
        clip = wav[:best_pos]

    # Add 100ms clean silence tail so generated speech starts crisply without blending into prompt
    pad = np.zeros(int(sr * 0.10), dtype=np.float32)
    clip = np.concatenate([clip, pad])
    sf.write(str(cache_path), clip, sr, subtype="PCM_16")
    return cache_path


def transcribe_prompt_audio(prompt_wav_path: Path, language: str = "vi") -> str:
    """Auto-transcribe the exact spoken words in a short prompt clip using faster-whisper."""
    model = _get_whisper()
    lang_code = "en" if language == "en" else "vi"
    segments, _ = model.transcribe(
        str(prompt_wav_path),
        language=lang_code,
        beam_size=3,
        vad_filter=True,
    )
    text = " ".join(seg.text.strip() for seg in segments if seg.text.strip()).strip()
    return text
