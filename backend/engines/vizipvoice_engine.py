from __future__ import annotations

import asyncio
import os
import sys
import threading
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from backend.config import BASE_DIR, MODELS_DIR
from backend.transcriber import extract_clean_prompt_clip, transcribe_prompt_audio

VIZIP_VENDOR_DIR = BASE_DIR / "vendor" / "ViZipvoice"
VIZIP_ONNX_DIR = MODELS_DIR / "vizipvoice_onnx"

VIZIP_PRESETS: dict[str, dict[str, Any]] = {
    "turbo": {"steps": 6, "guidance_scale": 1.3},
    "balanced": {"steps": 8, "guidance_scale": 1.5},
    "high": {"steps": 12, "guidance_scale": 1.6},
}


class ViZipVoiceEngine:
    """
    Flagship 100% Offline Vietnamese Zero-Shot Voice Cloning via contextboxai/ViZipvoice
    (7,000 hours Vietnamese + English Flow-Matching, ONNX INT8 CPU + Vocos 24kHz).
    Uses exact in-context prompt_wav + prompt_text alignment to preserve exact regional
    accent (Northern/Central/Southern), timbre, age, and cadence.
    """

    def __init__(self) -> None:
        self._onnx_model: Any = None
        self._tokenizer: Any = None
        self._fbank: Any = None
        self._vocoder: Any = None
        self._normalizer: Any = None
        self._loading = False
        self._load_stage = ""
        self._last_error: str | None = None
        self._lock = threading.Lock()
        self._prompt_cache: dict[str, tuple[Any, list[list[int]], str]] = {}

    def is_ready(self) -> bool:
        return (
            VIZIP_VENDOR_DIR.exists()
            and (VIZIP_ONNX_DIR / "text_encoder_int8.onnx").exists()
            and (VIZIP_ONNX_DIR / "fm_decoder_int8.onnx").exists()
            and (VIZIP_ONNX_DIR / "tokens.txt").exists()
        )

    def _patch_torchaudio(self) -> None:
        import torch
        import torchaudio

        def _sf_load(path, *args, **kwargs):
            data, sr = sf.read(str(path), dtype="float32", always_2d=True)
            return torch.from_numpy(data.T.copy()), int(sr)

        def _sf_save(path, tensor, sample_rate, *args, **kwargs):
            arr = tensor.detach().cpu().numpy()
            if arr.ndim == 2:
                arr = arr.T
            sf.write(str(path), arr, int(sample_rate), subtype="PCM_16")

        torchaudio.load = _sf_load
        torchaudio.save = _sf_save

    def _ensure_loaded_sync(self) -> None:
        with self._lock:
            if self._onnx_model is not None:
                return
            if not self.is_ready():
                raise RuntimeError("Mô hình ViZipVoice ONNX INT8 chưa sẵn sàng trong data/models/vizipvoice_onnx.")
            self._loading = True
            self._last_error = None
            self._load_stage = "Đang nạp ViZipVoice 7000h (ONNX INT8 + Vocos)..."
            try:
                if str(VIZIP_VENDOR_DIR) not in sys.path:
                    sys.path.insert(0, str(VIZIP_VENDOR_DIR))
                self._patch_torchaudio()

                from zipvoice.bin.infer_zipvoice import get_vocoder
                from zipvoice.bin.infer_zipvoice_onnx import OnnxModel
                from zipvoice.tokenizer.tokenizer import SimpleTokenizer
                from zipvoice.utils.feature import VocosFbank

                phys_threads = max(1, min((os.cpu_count() or 4) // 2, 4))
                self._onnx_model = OnnxModel(
                    str(VIZIP_ONNX_DIR / "text_encoder_int8.onnx"),
                    str(VIZIP_ONNX_DIR / "fm_decoder_int8.onnx"),
                    num_thread=phys_threads,
                )
                self._tokenizer = SimpleTokenizer(token_file=str(VIZIP_ONNX_DIR / "tokens.txt"))
                self._fbank = VocosFbank()
                self._vocoder = get_vocoder(None).eval()

                try:
                    from soe_vinorm import SoeNormalizer

                    self._normalizer = SoeNormalizer()
                except Exception:
                    self._normalizer = None

                self._load_stage = "Sẵn sàng (ONNX INT8 · 24 kHz)"
            except Exception as exc:
                self._last_error = str(exc)
                self._load_stage = f"Lỗi nạp ViZipVoice: {exc}"
                raise
            finally:
                self._loading = False

    def _normalize_vi(self, text: str) -> str:
        t = text.strip()
        if self._normalizer is not None:
            try:
                t = self._normalizer.normalize(t)
            except Exception:
                pass
        return t.lower().strip()

    def _get_prompt_features_sync(
        self,
        ref_audio_path: Path,
        ref_text: str,
        language: str = "vi",
    ) -> tuple[Any, list[list[int]], str]:
        """Extract & cache (prompt_features, prompt_tokens, resolved_ref_text) once per cloned voice."""
        prompt_clip = extract_clean_prompt_clip(ref_audio_path, target_sec=5.2, max_sec=6.4)
        resolved_text = ref_text.strip()

        cache_key = f"{prompt_clip.name}::{resolved_text}"
        if resolved_text and cache_key in self._prompt_cache:
            return self._prompt_cache[cache_key]

        # Check if we already auto-transcribed this exact prompt clip
        auto_key = f"{prompt_clip.name}::__auto__"
        if not resolved_text and auto_key in self._prompt_cache:
            return self._prompt_cache[auto_key]

        if not resolved_text:
            self._load_stage = "Đang tự động nhận diện lời thoại mẫu giọng (Whisper)..."
            resolved_text = transcribe_prompt_audio(prompt_clip, language=language)
            if not resolved_text:
                resolved_text = "xin chào đây là giọng nói mẫu của tôi."
            self._load_stage = "Sẵn sàng (ONNX INT8 · 24 kHz)"

        from zipvoice.utils.infer import load_prompt_wav, rms_norm

        pwav = load_prompt_wav(str(prompt_clip), sampling_rate=24000)
        pwav, _ = rms_norm(pwav, target_rms=0.1)
        pfeat = self._fbank.extract(pwav, sampling_rate=24000).unsqueeze(0) * 0.1
        norm_prompt = self._normalize_vi(resolved_text)
        ptok = self._tokenizer.texts_to_token_ids([norm_prompt])

        val = (pfeat, ptok, resolved_text)
        self._prompt_cache[f"{prompt_clip.name}::{resolved_text}"] = val
        if not ref_text.strip():
            self._prompt_cache[auto_key] = val
        return val

    async def prepare_model(self) -> dict[str, Any]:
        if self._onnx_model is not None:
            return {"status": "ready"}
        await asyncio.to_thread(self._ensure_loaded_sync)
        return {"status": "ready"}

    async def synthesize_chunk(
        self,
        text: str,
        ref_audio_path: Path,
        ref_text: str = "",
        language: str = "vi",
        speed: float = 1.0,
        quality_mode: str = "turbo",
    ) -> tuple[np.ndarray, int, str]:
        """Returns (float32_audio, 24000, resolved_ref_text)."""
        preset = VIZIP_PRESETS.get(quality_mode, VIZIP_PRESETS["turbo"])

        def _run() -> tuple[np.ndarray, int, str]:
            import torch

            self._ensure_loaded_sync()
            pfeat, ptok, resolved_text = self._get_prompt_features_sync(
                ref_audio_path=ref_audio_path,
                ref_text=ref_text,
                language=language,
            )

            from zipvoice.bin.infer_zipvoice_onnx import sample

            norm_text = self._normalize_vi(text)
            gtok = self._tokenizer.texts_to_token_ids([norm_text])

            with self._lock:
                pred_feat = sample(
                    model=self._onnx_model,
                    tokens=gtok,
                    prompt_tokens=ptok,
                    prompt_features=pfeat,
                    speed=float(speed),
                    t_shift=0.5,
                    guidance_scale=float(preset["guidance_scale"]),
                    num_step=int(preset["steps"]),
                )
                pred_feat = pred_feat.permute(0, 2, 1) / 0.1
                with torch.inference_mode():
                    wav = self._vocoder.decode(pred_feat).squeeze(1).clamp(-1, 1).cpu().numpy()[0]
            return np.asarray(wav, dtype=np.float32), 24000, resolved_text

        return await asyncio.to_thread(_run)

    def get_status(self) -> dict[str, Any]:
        ready = self.is_ready()
        return {
            "id": "vizipvoice",
            "name": "ViZipVoice 7000h (Clone chuẩn nhất)",
            "source_repo": "contextboxai/ViZipvoice · k2-fsa/ZipVoice",
            "installed": ready,
            "loaded": self._onnx_model is not None,
            "loading": self._loading,
            "ready": ready,
            "download_stage": self._load_stage,
            "last_error": self._last_error,
            "supports_cloning": True,
            "supports_blending": False,
            "supports_subtitles": True,
            "max_chunk_chars": 160,
            "badge": "Giống Thật 99% · Offline ONNX",
            "description": "Mô hình Flow-Matching huấn luyện trên 7.000 giờ tiếng Việt, đối chiếu chính xác từng âm tiết với giọng mẫu (tự động nhận diện ref_text). Giữ trọn vùng miền Bắc/Trung/Nam và chất giọng thật — 100% offline không giới hạn.",
        }


vizipvoice_engine = ViZipVoiceEngine()
