from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


class ClonedVoiceProfile(BaseModel):
    id: str
    name: str
    language: str = "vi"
    gender: str = "neutral"
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    avatar_gradient: str = "from-amber-500 to-orange-600"
    audio_filename: str
    audio_url: str
    duration_sec: float = 0.0
    quality_score: int = 85
    quality_note: str = ""
    ref_text: str = ""
    waveform_peaks: list[float] = Field(default_factory=list)
    pitch_hz: float = 160.0
    created_at: str


class StockVoiceInfo(BaseModel):
    id: str
    name: str
    short_name: str
    engine: str
    language: str
    locale: str
    gender: str
    style_tags: list[str] = Field(default_factory=list)
    recommended: bool = False


class SynthesizeRequest(BaseModel):
    title: str = ""
    text: str = Field(..., min_length=1)
    engine: Literal["edge", "vizipvoice", "zipvoice_gpu", "f5_gpu", "vieneu", "kokoro", "hybrid_clone"] = "edge"
    voice_id: str = "vi-VN-HoaiMyNeural"
    cloned_voice_id: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    pitch: int = Field(default=0, ge=-24, le=24)  # semitones / percent shift
    volume: int = Field(default=0, ge=-50, le=50)
    pause_ms: int = Field(default=220, ge=0, le=2000)
    crossfade_ms: int = Field(default=45, ge=0, le=300)
    output_format: Literal["mp3", "wav"] = "mp3"
    normalize_audio: bool = True
    generate_subtitles: bool = True
    # Kokoro voice blending
    blend_voice_id: str | None = None
    blend_ratio: float = Field(default=0.5, ge=0.0, le=1.0)
    # Optional expressive / clone tuning
    temperature: float = Field(default=0.75, ge=0.1, le=1.5)
    clone_strength: float = Field(default=0.85, ge=0.1, le=1.0)
    quality_mode: Literal["turbo", "balanced", "high"] = "turbo"


class DialogueLine(BaseModel):
    id: str = ""
    speaker: str = "Speaker 1"
    text: str = Field(..., min_length=1)
    engine: Literal["edge", "vizipvoice", "zipvoice_gpu", "f5_gpu", "vieneu", "kokoro", "hybrid_clone"] = "edge"
    voice_id: str = "vi-VN-HoaiMyNeural"
    cloned_voice_id: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    pitch: int = Field(default=0, ge=-24, le=24)
    pause_after_ms: int = Field(default=380, ge=0, le=3000)


class DialogueRequest(BaseModel):
    title: str = "Multi-Speaker Podcast"
    lines: list[DialogueLine] = Field(..., min_length=1)
    output_format: Literal["mp3", "wav"] = "mp3"
    normalize_audio: bool = True
    generate_subtitles: bool = True


class ChunkProgress(BaseModel):
    index: int
    text_preview: str
    char_count: int
    status: Literal["queued", "processing", "done", "error"] = "queued"
    duration_sec: float = 0.0
    speaker: str | None = None


class JobRecord(BaseModel):
    job_id: str
    title: str
    mode: Literal["single", "dialogue"] = "single"
    status: Literal["queued", "running", "stitching", "completed", "cancelled", "error"] = "queued"
    progress: float = 0.0
    current_chunk: int = 0
    total_chunks: int = 0
    chunks: list[ChunkProgress] = Field(default_factory=list)
    engine: str = "edge"
    voice_name: str = ""
    cloned_voice_id: str | None = None
    char_count: int = 0
    word_count: int = 0
    duration_sec: float = 0.0
    output_format: str = "mp3"
    audio_url: str | None = None
    wav_url: str | None = None
    subtitle_srt_url: str | None = None
    subtitle_vtt_url: str | None = None
    waveform_peaks: list[float] = Field(default_factory=list)
    text_preview: str = ""
    favorite: bool = False
    error: str | None = None
    created_at: str = ""
    extra: dict[str, Any] = Field(default_factory=dict)
