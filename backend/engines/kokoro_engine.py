from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from backend.config import MODELS_DIR
from backend.models import StockVoiceInfo

KOKORO_DIR = MODELS_DIR / "kokoro"
KOKORO_DIR.mkdir(parents=True, exist_ok=True)
MODEL_PATH = KOKORO_DIR / "kokoro-v1.0.onnx"
VOICES_PATH = KOKORO_DIR / "voices-v1.0.bin"

MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"

KOKORO_VOICES: list[StockVoiceInfo] = [
    StockVoiceInfo(id="af_heart", name="Heart (US · Female · Signature)", short_name="Heart", engine="kokoro", language="English", locale="en-us", gender="Female", style_tags=["Warm", "Top-Rated", "82M"], recommended=True),
    StockVoiceInfo(id="af_bella", name="Bella (US · Female · Expressive)", short_name="Bella", engine="kokoro", language="English", locale="en-us", gender="Female", style_tags=["Expressive", "Storytelling"], recommended=True),
    StockVoiceInfo(id="af_nicole", name="Nicole (US · Female · ASMR/Soft)", short_name="Nicole", engine="kokoro", language="English", locale="en-us", gender="Female", style_tags=["Soft", "Intimate"], recommended=False),
    StockVoiceInfo(id="af_sarah", name="Sarah (US · Female · Studio)", short_name="Sarah", engine="kokoro", language="English", locale="en-us", gender="Female", style_tags=["Studio", "Clear"], recommended=False),
    StockVoiceInfo(id="af_sky", name="Sky (US · Female · Bright)", short_name="Sky", engine="kokoro", language="English", locale="en-us", gender="Female", style_tags=["Bright", "Modern"], recommended=False),
    StockVoiceInfo(id="am_adam", name="Adam (US · Male · Narrator)", short_name="Adam", engine="kokoro", language="English", locale="en-us", gender="Male", style_tags=["Deep", "Narrator"], recommended=True),
    StockVoiceInfo(id="am_michael", name="Michael (US · Male · Warm)", short_name="Michael", engine="kokoro", language="English", locale="en-us", gender="Male", style_tags=["Warm", "Podcast"], recommended=True),
    StockVoiceInfo(id="am_fenrir", name="Fenrir (US · Male · Cinematic)", short_name="Fenrir", engine="kokoro", language="English", locale="en-us", gender="Male", style_tags=["Cinematic", "Bold"], recommended=False),
    StockVoiceInfo(id="bf_emma", name="Emma (UK · Female · Classic)", short_name="Emma", engine="kokoro", language="English", locale="en-gb", gender="Female", style_tags=["British", "Audiobook"], recommended=True),
    StockVoiceInfo(id="bf_isabella", name="Isabella (UK · Female · Crisp)", short_name="Isabella", engine="kokoro", language="English", locale="en-gb", gender="Female", style_tags=["British", "Crisp"], recommended=False),
    StockVoiceInfo(id="bm_george", name="George (UK · Male · Documentary)", short_name="George", engine="kokoro", language="English", locale="en-gb", gender="Male", style_tags=["British", "Documentary"], recommended=True),
    StockVoiceInfo(id="bm_lewis", name="Lewis (UK · Male · Smooth)", short_name="Lewis", engine="kokoro", language="English", locale="en-gb", gender="Male", style_tags=["British", "Smooth"], recommended=False),
]


class KokoroTTSEngine:
    """
    Adapter for hexgrad/kokoro (via kokoro-onnx):
    Ultra-fast 82M Apache-2.0 CPU TTS + Signature Voice Blending (mix 2 voice style embeddings).
    """

    def __init__(self) -> None:
        self._instance: Any = None
        self._downloading = False
        self._download_progress = 0.0
        self._download_stage = ""
        self._last_error: str | None = None
        self._lock = asyncio.Lock()

    def is_package_installed(self) -> bool:
        try:
            import kokoro_onnx  # noqa: F401
            return True
        except Exception:
            return False

    def is_model_downloaded(self) -> bool:
        return (
            MODEL_PATH.exists()
            and MODEL_PATH.stat().st_size > 10_000_000
            and VOICES_PATH.exists()
            and VOICES_PATH.stat().st_size > 100_000
        )

    def list_voices(self) -> list[StockVoiceInfo]:
        return KOKORO_VOICES

    async def download_models(self) -> dict[str, Any]:
        if self._downloading:
            return {"status": "downloading", "progress": self._download_progress}
        self._downloading = True
        self._last_error = None
        self._download_progress = 0.0
        try:
            files = [
                ("voices-v1.0.bin", VOICES_URL, VOICES_PATH, 0.0, 0.15),
                ("kokoro-v1.0.onnx", MODEL_URL, MODEL_PATH, 0.15, 1.0),
            ]
            async with httpx.AsyncClient(follow_redirects=True, timeout=600.0) as client:
                for label, url, dest, p_start, p_end in files:
                    if dest.exists() and dest.stat().st_size > 100_000:
                        self._download_progress = p_end * 100.0
                        continue
                    self._download_stage = f"Đang tải {label}..."
                    tmp = dest.with_suffix(dest.suffix + ".part")
                    async with client.stream("GET", url) as resp:
                        resp.raise_for_status()
                        total = int(resp.headers.get("content-length", "0"))
                        done = 0
                        with tmp.open("wb") as f:
                            async for chunk in resp.aiter_bytes(chunk_size=131072):
                                f.write(chunk)
                                done += len(chunk)
                                if total > 0:
                                    frac = done / total
                                    self._download_progress = round((p_start + frac * (p_end - p_start)) * 100.0, 1)
                    tmp.replace(dest)
            self._download_progress = 100.0
            self._download_stage = "Sẵn sàng"
            return {"status": "ready", "progress": 100.0}
        except Exception as exc:
            self._last_error = str(exc)
            self._download_stage = f"Lỗi tải model: {exc}"
            raise
        finally:
            self._downloading = False

    def _ensure_loaded_sync(self) -> Any:
        if self._instance is not None:
            return self._instance
        if not self.is_package_installed():
            raise RuntimeError("Gói kokoro-onnx chưa được cài đặt.")
        if not self.is_model_downloaded():
            raise RuntimeError("Model Kokoro-82M ONNX chưa được tải. Hãy bấm 'Tải Model Kokoro' trong Engine Hub.")
        from kokoro_onnx import Kokoro

        self._instance = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
        return self._instance

    async def synthesize_chunk(
        self,
        text: str,
        voice_id: str = "af_heart",
        speed: float = 1.0,
        blend_voice_id: str | None = None,
        blend_ratio: float = 0.5,
    ) -> tuple[np.ndarray, int]:
        def _run() -> tuple[np.ndarray, int]:
            kokoro = self._ensure_loaded_sync()
            lang = "en-gb" if voice_id.startswith("b") else "en-us"
            if blend_voice_id and blend_voice_id != voice_id:
                try:
                    v1 = kokoro.get_voice_style(voice_id)
                    v2 = kokoro.get_voice_style(blend_voice_id)
                    blended = v1 * float(blend_ratio) + v2 * (1.0 - float(blend_ratio))
                    samples, sr = kokoro.create(text, voice=blended, speed=float(speed), lang=lang)
                    return np.asarray(samples, dtype=np.float32), int(sr)
                except Exception:
                    pass
            samples, sr = kokoro.create(text, voice=voice_id, speed=float(speed), lang=lang)
            return np.asarray(samples, dtype=np.float32), int(sr)

        return await asyncio.to_thread(_run)

    def get_status(self) -> dict[str, Any]:
        installed = self.is_package_installed()
        downloaded = self.is_model_downloaded()
        return {
            "id": "kokoro",
            "name": "Kokoro-82M ONNX",
            "source_repo": "hexgrad/kokoro",
            "installed": installed,
            "downloaded": downloaded,
            "ready": installed and downloaded,
            "loaded": self._instance is not None,
            "downloading": self._downloading,
            "download_progress": self._download_progress,
            "download_stage": self._download_stage,
            "last_error": self._last_error,
            "supports_cloning": False,
            "supports_blending": True,
            "supports_subtitles": True,
            "max_chunk_chars": 360,
            "badge": "Offline CPU · Mix 2 Giọng",
            "description": "Mô hình 82M siêu nhẹ chạy hoàn toàn offline trên CPU, hỗ trợ trộn DNA 2 giọng nói (Voice Blending) để tạo chất giọng độc bản.",
        }


kokoro_engine = KokoroTTSEngine()
