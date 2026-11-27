from __future__ import annotations

import asyncio
from typing import Any

import edge_tts
import numpy as np

from backend.audio_utils import load_mp3_bytes_to_numpy
from backend.models import StockVoiceInfo

# Curated fallback voices if offline or before first fetch
DEFAULT_EDGE_VOICES: list[StockVoiceInfo] = [
    StockVoiceInfo(
        id="vi-VN-HoaiMyNeural",
        name="Hoài My (Việt Nam · Nữ)",
        short_name="Hoài My",
        engine="edge",
        language="Vietnamese",
        locale="vi-VN",
        gender="Female",
        style_tags=["Tự nhiên", "Truyền cảm", "Podcast"],
        recommended=True,
    ),
    StockVoiceInfo(
        id="vi-VN-NamMinhNeural",
        name="Nam Minh (Việt Nam · Nam)",
        short_name="Nam Minh",
        engine="edge",
        language="Vietnamese",
        locale="vi-VN",
        gender="Male",
        style_tags=["Trầm ấm", "Tin tức", "Thuyết minh"],
        recommended=True,
    ),
    StockVoiceInfo(
        id="en-US-AndrewMultilingualNeural",
        name="Andrew Multilingual (US · Male)",
        short_name="Andrew",
        engine="edge",
        language="Multilingual",
        locale="en-US",
        gender="Male",
        style_tags=["Warm", "Multilingual", "Narrator"],
        recommended=True,
    ),
    StockVoiceInfo(
        id="en-US-AvaMultilingualNeural",
        name="Ava Multilingual (US · Female)",
        short_name="Ava",
        engine="edge",
        language="Multilingual",
        locale="en-US",
        gender="Female",
        style_tags=["Expressive", "Multilingual", "Story"],
        recommended=True,
    ),
    StockVoiceInfo(
        id="en-US-BrianMultilingualNeural",
        name="Brian Multilingual (US · Male)",
        short_name="Brian",
        engine="edge",
        language="Multilingual",
        locale="en-US",
        gender="Male",
        style_tags=["Deep", "Documentary", "Multilingual"],
        recommended=True,
    ),
    StockVoiceInfo(
        id="en-US-EmmaMultilingualNeural",
        name="Emma Multilingual (US · Female)",
        short_name="Emma",
        engine="edge",
        language="Multilingual",
        locale="en-US",
        gender="Female",
        style_tags=["Clear", "Conversational", "Multilingual"],
        recommended=True,
    ),
]


class EdgeTTSEngine:
    """
    Adapter for rany2/edge-tts:
    300+ Microsoft Neural voices, zero GPU overhead, rate/pitch/volume control,
    and word-level timing extraction for studio subtitles.
    """

    def __init__(self) -> None:
        self._voices_cache: list[StockVoiceInfo] | None = None
        self._lock = asyncio.Lock()

    async def list_voices(self) -> list[StockVoiceInfo]:
        async with self._lock:
            if self._voices_cache is not None:
                return self._voices_cache
            try:
                raw_voices = await asyncio.wait_for(edge_tts.list_voices(), timeout=10.0)
                parsed: list[StockVoiceInfo] = []
                priority_ids = {v.id for v in DEFAULT_EDGE_VOICES}

                for item in raw_voices:
                    short_id = item.get("ShortName", "")
                    locale = item.get("Locale", "")
                    gender = item.get("Gender", "Neutral")
                    friendly = item.get("FriendlyName", short_id)
                    # Extract clean display name
                    clean_short = short_id.split("-")[-1].replace("Neural", "").replace("Multilingual", " Multi")
                    lang_label = locale
                    if locale.startswith("vi-"):
                        lang_label = "Vietnamese"
                    elif locale.startswith("en-"):
                        lang_label = "English"
                    elif locale.startswith("ja-"):
                        lang_label = "Japanese"
                    elif locale.startswith("ko-"):
                        lang_label = "Korean"
                    elif locale.startswith("zh-"):
                        lang_label = "Chinese"
                    elif locale.startswith("fr-"):
                        lang_label = "French"
                    elif locale.startswith("de-"):
                        lang_label = "German"
                    elif locale.startswith("es-"):
                        lang_label = "Spanish"

                    tags = []
                    if "Multilingual" in short_id:
                        tags.append("Multilingual")
                    if locale == "vi-VN":
                        tags.append("Tiếng Việt")
                    if item.get("VoiceTag", {}).get("VoicePersonalities"):
                        tags.extend(item["VoiceTag"]["VoicePersonalities"][:2])

                    parsed.append(
                        StockVoiceInfo(
                            id=short_id,
                            name=f"{clean_short} ({locale} · {gender})",
                            short_name=clean_short,
                            engine="edge",
                            language=lang_label,
                            locale=locale,
                            gender=gender,
                            style_tags=tags[:3],
                            recommended=(short_id in priority_ids or locale == "vi-VN"),
                        )
                    )

                # Sort: Vietnamese first, then recommended multilingual, then English, then rest
                def _sort_key(v: StockVoiceInfo) -> tuple[int, int, str]:
                    if v.locale == "vi-VN":
                        return (0, 0, v.name)
                    if v.recommended:
                        return (1, 0, v.name)
                    if "Multilingual" in v.id:
                        return (2, 0, v.name)
                    if v.locale.startswith("en-US"):
                        return (3, 0, v.name)
                    return (4, 0, v.locale + v.name)

                parsed.sort(key=_sort_key)
                self._voices_cache = parsed
                return parsed
            except Exception:
                return DEFAULT_EDGE_VOICES

    @staticmethod
    def _format_rate(speed: float) -> str:
        pct = int(round((speed - 1.0) * 100))
        return f"+{pct}%" if pct >= 0 else f"{pct}%"

    @staticmethod
    def _format_pitch(pitch: int) -> str:
        # Map slider (-24..24) to Hz shift (-40Hz..+40Hz)
        hz = int(round(pitch * 2.5))
        return f"+{hz}Hz" if hz >= 0 else f"{hz}Hz"

    @staticmethod
    def _format_volume(volume: int) -> str:
        return f"+{volume}%" if volume >= 0 else f"{volume}%"

    async def synthesize_chunk(
        self,
        text: str,
        voice_id: str = "vi-VN-HoaiMyNeural",
        speed: float = 1.0,
        pitch: int = 0,
        volume: int = 0,
        target_sr: int = 24000,
    ) -> tuple[np.ndarray, int, list[dict[str, Any]]]:
        """
        Synthesize one chunk via Microsoft Edge Neural TTS.
        Returns (float32_audio, sample_rate, boundary_events).
        """
        rate_str = self._format_rate(speed)
        pitch_str = self._format_pitch(pitch)
        vol_str = self._format_volume(volume)

        last_err: Exception | None = None
        for attempt in range(3):
            try:
                communicate = edge_tts.Communicate(
                    text=text,
                    voice=voice_id,
                    rate=rate_str,
                    pitch=pitch_str,
                    volume=vol_str,
                )

                audio_chunks: list[bytes] = []
                boundaries: list[dict[str, Any]] = []

                async for msg in communicate.stream():
                    msg_type = msg.get("type")
                    if msg_type == "audio":
                        data = msg.get("data")
                        if data:
                            audio_chunks.append(data)
                    elif msg_type in ("WordBoundary", "SentenceBoundary"):
                        offset_s = msg.get("offset", 0) / 10_000_000.0
                        dur_s = msg.get("duration", 0) / 10_000_000.0
                        boundaries.append(
                            {
                                "type": msg_type,
                                "start": offset_s,
                                "end": offset_s + dur_s,
                                "text": msg.get("text", ""),
                            }
                        )

                if audio_chunks:
                    mp3_bytes = b"".join(audio_chunks)
                    audio_np, sr = await asyncio.to_thread(load_mp3_bytes_to_numpy, mp3_bytes, target_sr)
                    return audio_np, sr, boundaries
                last_err = RuntimeError("Edge-TTS trả về luồng rỗng.")
            except Exception as exc:
                last_err = exc
            await asyncio.sleep(0.6 * (attempt + 1))

        raise RuntimeError(f"Edge-TTS lỗi sau 3 lần thử: {last_err}")

    def get_status(self) -> dict[str, Any]:
        return {
            "id": "edge",
            "name": "Edge Neural Cloud",
            "source_repo": "rany2/edge-tts",
            "ready": True,
            "supports_cloning": False,
            "supports_blending": False,
            "supports_subtitles": True,
            "max_chunk_chars": 1000,
            "badge": "Siêu tốc · 300+ giọng",
            "description": "Kết hợp sức mạnh Microsoft Neural Voices: không cần GPU, tốc độ cực nhanh, hỗ trợ tiếng Việt cực mượt và tạo phụ đề SRT từng chữ.",
        }


edge_engine = EdgeTTSEngine()
