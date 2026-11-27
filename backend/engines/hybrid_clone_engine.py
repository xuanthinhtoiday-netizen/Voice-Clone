from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import numpy as np

from backend.audio_utils import apply_clean_tone_match, get_cached_ref_profile
from backend.engines.edge_engine import edge_engine


class HybridCloneEngine:
    """
    Studio-Clean Hybrid Turbo Clone:
    - Uses native neural pitch shifting inside the neural vocoder (zero STFT echo/buzz!)
    - Applies gentle 2-band RBJ shelving tone match (warmth & brightness) from the reference voice
    - Runs 4x parallel chunks for ultra-fast unlimited-length crystal-clear speech.
    """

    async def synthesize_chunk(
        self,
        text: str,
        ref_audio_path: Path,
        base_voice_id: str = "vi-VN-HoaiMyNeural",
        speed: float = 1.0,
        pitch: int = 0,
        volume: int = 0,
        clone_strength: float = 0.85,
        target_sr: int = 24000,
    ) -> tuple[np.ndarray, int, list[dict[str, Any]]]:
        ref_profile = await asyncio.to_thread(get_cached_ref_profile, ref_audio_path, target_sr)

        # Estimate native neural pitch offset cleanly (zero phase vocoder distortion!)
        ref_f0 = ref_profile["f0"]
        # Auto-pick base gender voice F0 anchor: NamMinh ~125Hz, HoaiMy ~215Hz
        is_male_base = "NamMinh" in base_voice_id or "Male" in base_voice_id
        base_f0 = 128.0 if is_male_base else 210.0

        # Convert Hz difference to Edge-TTS pitch slider units (1 unit = 2.5 Hz), gently clamped
        delta_hz = (ref_f0 - base_f0) * clone_strength * 0.38
        auto_pitch_units = int(round(np.clip(delta_hz / 2.5, -10.0, 10.0)))
        effective_pitch = int(np.clip(pitch + auto_pitch_units, -16, 16))

        base_audio, sr, boundaries = await edge_engine.synthesize_chunk(
            text=text,
            voice_id=base_voice_id,
            speed=speed,
            pitch=effective_pitch,
            volume=volume,
            target_sr=target_sr,
        )

        # Apply ultra-clean 2-band shelving warmth/brightness match (zero STFT echo/reverb)
        matched = await asyncio.to_thread(
            apply_clean_tone_match,
            base_audio,
            sr,
            ref_profile,
            clone_strength,
        )
        return matched, sr, boundaries

    def get_status(self) -> dict[str, Any]:
        return {
            "id": "hybrid_clone",
            "name": "VoxForge Hybrid Turbo Clone",
            "source_repo": "Edge Neural Pitch + Clean Tone Match",
            "ready": True,
            "supports_cloning": True,
            "supports_blending": False,
            "supports_subtitles": True,
            "max_chunk_chars": 950,
            "badge": "Clone Siêu Tốc · Âm Sạch",
            "description": "Kết hợp dịch cao độ trực tiếp trong Neural Vocoder (không rè, không vang) với cân bằng âm sắc 2 dải từ giọng clone — siêu nhanh cho văn bản dài.",
        }


hybrid_clone_engine = HybridCloneEngine()
