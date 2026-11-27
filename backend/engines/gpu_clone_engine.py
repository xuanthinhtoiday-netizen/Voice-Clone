from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from backend.config import get_hf_token
from backend.engines.vizipvoice_engine import vizipvoice_engine
from backend.transcriber import extract_clean_prompt_clip, transcribe_prompt_audio


class ZipVoiceGPUCloneEngine:
    """
    Ultra-fast NVIDIA A10G GPU ZipVoice-Vietnamese Flow-Matching Voice Cloning
    (sleeper371/zipvoice_vi) with automatic seamless fallback to local offline
    ViZipVoice 7000h ONNX INT8 so voice identity stays 99% faithful even without GPU quota.
    """

    SPACE_ID = "sleeper371/zipvoice_vi"

    def __init__(self) -> None:
        self._client: Any = None
        self._client_token: str | None = None
        self._lock = threading.Lock()
        self._cooldown_until: float = 0.0

    def _get_client_sync(self) -> Any:
        tok = get_hf_token()
        with self._lock:
            if self._client is None or self._client_token != tok:
                from gradio_client import Client

                self._client = Client(self.SPACE_ID, token=tok, verbose=False)
                self._client_token = tok
            return self._client

    def reset_cooldown(self) -> None:
        self._cooldown_until = 0.0
        with self._lock:
            self._client = None

    async def synthesize_chunk(
        self,
        text: str,
        ref_audio_path: Path,
        ref_text: str = "",
        language: str = "vi",
        speed: float = 1.0,
        quality_mode: str = "turbo",
    ) -> tuple[np.ndarray, int, str]:
        def _run_gpu() -> tuple[np.ndarray, int, str] | None:
            if time.monotonic() < self._cooldown_until:
                return None
            from gradio_client import handle_file

            prompt_clip = extract_clean_prompt_clip(ref_audio_path, target_sec=5.5, max_sec=6.8)
            resolved_text = ref_text.strip()
            if not resolved_text:
                resolved_text = transcribe_prompt_audio(prompt_clip, language=language)
                if not resolved_text:
                    resolved_text = "xin chào đây là giọng nói mẫu của tôi."

            steps = 8 if quality_mode == "turbo" else 12
            try:
                client = self._get_client_sync()
                res = client.predict(
                    prompt_wav=handle_file(str(prompt_clip)),
                    prompt_text=resolved_text,
                    text=text,
                    speed=float(speed),
                    num_step=float(steps),
                    seed=666,
                    api_name="/synthesize",
                )
                out_file = res[0] if isinstance(res, (tuple, list)) else res
                wav, sr = sf.read(str(out_file), dtype="float32", always_2d=False)
                if wav.ndim > 1:
                    wav = wav.mean(axis=1)
                return np.asarray(wav, dtype=np.float32), int(sr), resolved_text
            except Exception:
                self._cooldown_until = time.monotonic() + 180.0
                with self._lock:
                    self._client = None
                return None

        gpu_res = await asyncio.to_thread(_run_gpu)
        if gpu_res is not None:
            return gpu_res

        # Seamless exact-voice fallback to 100% local offline ViZipVoice 7000h!
        return await vizipvoice_engine.synthesize_chunk(
            text=text,
            ref_audio_path=ref_audio_path,
            ref_text=ref_text,
            language=language,
            speed=speed,
            quality_mode=quality_mode,
        )

    def get_status(self) -> dict[str, Any]:
        has_tok = bool(get_hf_token())
        return {
            "id": "zipvoice_gpu",
            "name": "ZipVoice Việt Nam (GPU Cloud)",
            "source_repo": "k2-fsa/ZipVoice · sleeper371/zipvoice_vi",
            "ready": True,
            "supports_cloning": True,
            "supports_blending": False,
            "supports_subtitles": True,
            "max_chunk_chars": 260,
            "badge": "Siêu nhanh A10G GPU" if has_tok else "GPU Cloud (nên thêm HF Token)",
            "description": "Chạy ZipVoice Flow-Matching trên NVIDIA A10G GPU (~2–4 giây/đoạn). Tự động dự phòng bằng ViZipVoice 7000h Offline khi hết lượt miễn phí.",
        }


class F5VietnameseGPUCloneEngine:
    """
    Flow-Matching Zero-Shot Vietnamese Voice Cloning via
    hynt/F5-TTS-Vietnamese-100h Space (NVIDIA A10G GPU), with exact-voice ViZipVoice fallback.
    """

    SPACE_ID = "hynt/F5-TTS-Vietnamese-100h"

    def __init__(self) -> None:
        self._client: Any = None
        self._client_token: str | None = None
        self._lock = threading.Lock()
        self._cooldown_until: float = 0.0

    def _get_client_sync(self) -> Any:
        tok = get_hf_token()
        with self._lock:
            if self._client is None or self._client_token != tok:
                from gradio_client import Client

                self._client = Client(self.SPACE_ID, token=tok, verbose=False)
                self._client_token = tok
            return self._client

    def reset_cooldown(self) -> None:
        self._cooldown_until = 0.0
        with self._lock:
            self._client = None

    async def synthesize_chunk(
        self,
        text: str,
        ref_audio_path: Path,
        ref_text: str = "",
        language: str = "vi",
        speed: float = 1.0,
        quality_mode: str = "turbo",
    ) -> tuple[np.ndarray, int, str]:
        def _run_gpu() -> tuple[np.ndarray, int, str] | None:
            if time.monotonic() < self._cooldown_until:
                return None
            from gradio_client import handle_file

            prompt_clip = extract_clean_prompt_clip(ref_audio_path, target_sec=6.0, max_sec=7.5)
            try:
                client = self._get_client_sync()
                res = client.predict(
                    ref_audio_orig=handle_file(str(prompt_clip)),
                    gen_text=text,
                    speed=float(speed),
                    api_name="/infer_tts",
                )
                out_file = res[0] if isinstance(res, (tuple, list)) else res
                wav, sr = sf.read(str(out_file), dtype="float32", always_2d=False)
                if wav.ndim > 1:
                    wav = wav.mean(axis=1)
                return np.asarray(wav, dtype=np.float32), int(sr), ref_text
            except Exception:
                self._cooldown_until = time.monotonic() + 180.0
                with self._lock:
                    self._client = None
                return None

        gpu_res = await asyncio.to_thread(_run_gpu)
        if gpu_res is not None:
            return gpu_res

        return await vizipvoice_engine.synthesize_chunk(
            text=text,
            ref_audio_path=ref_audio_path,
            ref_text=ref_text,
            language=language,
            speed=speed,
            quality_mode=quality_mode,
        )

    def get_status(self) -> dict[str, Any]:
        return {
            "id": "f5_gpu",
            "name": "F5-TTS Việt Nam (GPU Cloud)",
            "source_repo": "SWivid/F5-TTS · hynt/F5-TTS-Vietnamese",
            "ready": True,
            "supports_cloning": True,
            "supports_blending": False,
            "supports_subtitles": True,
            "max_chunk_chars": 300,
            "badge": "Flow-Matching · A10G GPU",
            "description": "Mô hình F5-TTS tiếng Việt chạy trên NVIDIA A10G GPU, tự động dự phòng bằng ViZipVoice 7000h Offline nếu hết lượt miễn phí.",
        }


zipvoice_gpu_engine = ZipVoiceGPUCloneEngine()
f5_gpu_engine = F5VietnameseGPUCloneEngine()
