from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.audio_utils import analyze_and_preprocess_clone_sample
from backend.config import TEMP_DIR, VOICES_DIR, VOICES_META_FILE
from backend.models import ClonedVoiceProfile

AVATAR_GRADIENTS = [
    "from-amber-400 via-orange-500 to-rose-500",
    "from-cyan-400 via-teal-500 to-emerald-500",
    "from-fuchsia-500 via-purple-500 to-indigo-500",
    "from-rose-400 via-pink-500 to-amber-400",
    "from-sky-400 via-blue-500 to-violet-500",
    "from-lime-400 via-emerald-500 to-cyan-500",
]


class VoiceVault:
    """Persistent storage and preprocessing manager for cloned user voices."""

    def __init__(self) -> None:
        self._voices: dict[str, ClonedVoiceProfile] = {}
        self._load()

    def _load(self) -> None:
        if not VOICES_META_FILE.exists():
            return
        try:
            raw = json.loads(VOICES_META_FILE.read_text(encoding="utf-8"))
            for item in raw:
                profile = ClonedVoiceProfile(**item)
                if (VOICES_DIR / profile.audio_filename).exists():
                    self._voices[profile.id] = profile
        except Exception:
            self._voices = {}

    def _save(self) -> None:
        data = [v.model_dump() for v in self.list_voices()]
        VOICES_META_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def list_voices(self) -> list[ClonedVoiceProfile]:
        return sorted(self._voices.values(), key=lambda v: v.created_at, reverse=True)

    def get_voice(self, voice_id: str) -> ClonedVoiceProfile | None:
        return self._voices.get(voice_id)

    def get_audio_path(self, voice_id: str) -> Path | None:
        v = self._voices.get(voice_id)
        if not v:
            return None
        p = VOICES_DIR / v.audio_filename
        return p if p.exists() else None

    def create_voice(
        self,
        raw_bytes: bytes,
        original_filename: str,
        name: str,
        language: str = "vi",
        gender: str = "neutral",
        description: str = "",
        tags: list[str] | None = None,
        ref_text: str = "",
        denoise: bool = True,
    ) -> ClonedVoiceProfile:
        voice_id = f"clone_{uuid.uuid4().hex[:10]}"
        ext = Path(original_filename or "sample.wav").suffix.lower() or ".wav"
        raw_temp = TEMP_DIR / f"{voice_id}_raw{ext}"
        raw_temp.write_bytes(raw_bytes)

        clean_filename = f"{voice_id}.wav"
        clean_path = VOICES_DIR / clean_filename

        try:
            stats = analyze_and_preprocess_clone_sample(
                raw_path=raw_temp,
                clean_wav_path=clean_path,
                denoise=denoise,
                target_sr=24000,
            )
        finally:
            if raw_temp.exists():
                try:
                    raw_temp.unlink()
                except Exception:
                    pass

        gradient = AVATAR_GRADIENTS[len(self._voices) % len(AVATAR_GRADIENTS)]
        profile = ClonedVoiceProfile(
            id=voice_id,
            name=name.strip() or f"Giọng Clone #{len(self._voices) + 1}",
            language=language,
            gender=gender,
            description=description.strip(),
            tags=[t.strip() for t in (tags or []) if t.strip()],
            avatar_gradient=gradient,
            audio_filename=clean_filename,
            audio_url=f"/media/voices/{clean_filename}",
            duration_sec=stats["duration_sec"],
            quality_score=stats["quality_score"],
            quality_note=stats["quality_note"],
            ref_text=ref_text.strip(),
            waveform_peaks=stats["waveform_peaks"],
            pitch_hz=stats["pitch_hz"],
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self._voices[voice_id] = profile
        self._save()
        return profile

    def update_voice(self, voice_id: str, updates: dict[str, Any]) -> ClonedVoiceProfile | None:
        v = self._voices.get(voice_id)
        if not v:
            return None
        data = v.model_dump()
        for key in ("name", "language", "gender", "description", "tags", "ref_text"):
            if key in updates and updates[key] is not None:
                data[key] = updates[key]
        updated = ClonedVoiceProfile(**data)
        self._voices[voice_id] = updated
        self._save()
        return updated

    def delete_voice(self, voice_id: str) -> bool:
        v = self._voices.pop(voice_id, None)
        if not v:
            return False
        p = VOICES_DIR / v.audio_filename
        if p.exists():
            try:
                p.unlink()
            except Exception:
                pass
        self._save()
        return True


voice_vault = VoiceVault()
