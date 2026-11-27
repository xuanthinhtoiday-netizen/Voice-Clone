from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

from backend.config import get_ffmpeg_path


def decode_audio_to_mono_wav(
    input_path: Path,
    output_path: Path,
    target_sr: int = 24000,
) -> tuple[np.ndarray, int]:
    """
    Decode any audio format (webm, mp3, m4a, ogg, flac, wav) to mono float32 WAV.
    Tries soundfile directly first, falls back to bundled ffmpeg.
    """
    data: np.ndarray | None = None
    sr: int = target_sr

    try:
        arr, file_sr = sf.read(str(input_path), dtype="float32", always_2d=False)
        if arr.ndim > 1:
            arr = arr.mean(axis=1)
        data = arr
        sr = int(file_sr)
    except Exception:
        ffmpeg = get_ffmpeg_path()
        if not ffmpeg:
            raise RuntimeError(
                "Không thể giải mã định dạng audio này vì thiếu FFmpeg. Hãy cài imageio-ffmpeg hoặc dùng file WAV."
            )
        cmd = [
            ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-ac",
            "1",
            "-ar",
            str(target_sr),
            "-f",
            "wav",
            str(output_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"FFmpeg decode failed: {proc.stderr[-300:]}")
        arr, file_sr = sf.read(str(output_path), dtype="float32", always_2d=False)
        if arr.ndim > 1:
            arr = arr.mean(axis=1)
        data = arr
        sr = int(file_sr)

    if sr != target_sr and data is not None and len(data) > 0:
        data = resample_audio(data, sr, target_sr)
        sr = target_sr

    if data is None or len(data) == 0:
        raise RuntimeError("File audio rỗng hoặc không hợp lệ.")

    sf.write(str(output_path), data, sr, subtype="PCM_16")
    return data, sr


def resample_audio(audio: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    if orig_sr == target_sr or len(audio) == 0:
        return audio.astype(np.float32)
    gcd = np.gcd(orig_sr, target_sr)
    up = target_sr // gcd
    down = orig_sr // gcd
    resampled = signal.resample_poly(audio.astype(np.float32), up, down)
    return resampled.astype(np.float32)


def highpass_filter(audio: np.ndarray, sr: int, cutoff_hz: float = 75.0) -> np.ndarray:
    if len(audio) < 64:
        return audio
    sos = signal.butter(4, cutoff_hz, btype="highpass", fs=sr, output="sos")
    return signal.sosfiltfilt(sos, audio).astype(np.float32)


def trim_silence(audio: np.ndarray, sr: int, threshold_db: float = -38.0, pad_ms: int = 80) -> np.ndarray:
    if len(audio) == 0:
        return audio
    threshold = 10.0 ** (threshold_db / 20.0)
    frame_len = max(1, int(sr * 0.02))
    hop = max(1, frame_len // 2)
    energies = []
    for i in range(0, len(audio), hop):
        frame = audio[i : i + frame_len]
        rms = float(np.sqrt(np.mean(frame * frame) + 1e-12))
        energies.append(rms)
    active = [i for i, e in enumerate(energies) if e >= threshold]
    if not active:
        return audio
    pad_samples = int(sr * pad_ms / 1000)
    start = max(0, active[0] * hop - pad_samples)
    end = min(len(audio), active[-1] * hop + frame_len + pad_samples)
    return audio[start:end]


def gentle_denoise(audio: np.ndarray, sr: int) -> np.ndarray:
    """Very gentle spectral floor attenuation without watery/metallic musical-noise artifacts."""
    if len(audio) < sr // 4:
        return audio
    nperseg = 512
    _, _, Zxx = signal.stft(audio, fs=sr, nperseg=nperseg)
    mag = np.abs(Zxx)
    phase = np.angle(Zxx)
    frame_energy = np.mean(mag, axis=0)
    n_quiet = max(2, int(len(frame_energy) * 0.12))
    quiet_idx = np.argsort(frame_energy)[:n_quiet]
    noise_profile = np.median(mag[:, quiet_idx], axis=1, keepdims=True)
    # Soft gain mask (Wiener-like) with high floor so speech harmonics stay untouched
    snr_est = np.maximum(mag / (noise_profile + 1e-6), 0.0)
    gain = np.clip((snr_est - 0.65) / (snr_est + 0.35), 0.32, 1.0)
    Zxx_clean = (mag * gain) * np.exp(1j * phase)
    _, out = signal.istft(Zxx_clean, fs=sr, nperseg=nperseg)
    return out[: len(audio)].astype(np.float32)


def normalize_rms(audio: np.ndarray, target_dbfs: float = -20.0) -> np.ndarray:
    """
    Pure linear peak-safe loudness normalization.
    Never applies nonlinear tanh/overdrive clipping so speech stays 100% crisp with zero buzz.
    """
    if len(audio) == 0:
        return audio
    a = audio.astype(np.float32)
    # Remove DC offset
    a = a - float(np.mean(a))
    rms = float(np.sqrt(np.mean(a * a) + 1e-12))
    peak = float(np.max(np.abs(a)))
    if rms < 1e-6 or peak < 1e-6:
        return a
    target_rms = 10.0 ** (target_dbfs / 20.0)
    desired_gain = target_rms / rms
    # Strictly cap gain so maximum peak never exceeds 0.89 (-1 dBFS headroom, zero clipping!)
    max_safe_gain = 0.89 / peak
    gain = min(desired_gain, max_safe_gain, 6.0)
    return (a * gain).astype(np.float32)


def estimate_pitch_hz(audio: np.ndarray, sr: int) -> float:
    """Fast autocorrelation pitch estimator (F0) for speaker profiling."""
    if len(audio) < sr // 2:
        return 160.0
    # Analyze voiced middle window
    seg = audio[: min(len(audio), sr * 4)]
    frame_size = int(sr * 0.04)
    hop = frame_size // 2
    min_lag = max(1, int(sr / 360))  # 360 Hz max
    max_lag = max(min_lag + 1, int(sr / 75))  # 75 Hz min
    pitches: list[float] = []
    for i in range(0, len(seg) - frame_size, hop):
        frame = seg[i : i + frame_size]
        if float(np.sqrt(np.mean(frame * frame))) < 0.02:
            continue
        frame = frame - np.mean(frame)
        corr = np.correlate(frame, frame, mode="full")[frame_size - 1 :]
        if corr[0] <= 1e-9:
            continue
        search = corr[min_lag : min(max_lag, len(corr))]
        if len(search) == 0:
            continue
        peak_idx = int(np.argmax(search))
        if search[peak_idx] / corr[0] > 0.35:
            pitches.append(sr / (min_lag + peak_idx))
    if not pitches:
        return 160.0
    return round(float(np.median(pitches)), 1)


def analyze_and_preprocess_clone_sample(
    raw_path: Path,
    clean_wav_path: Path,
    denoise: bool = True,
    target_sr: int = 24000,
) -> dict:
    """
    Preprocess uploaded/recorded reference voice for cloning:
    decode -> highpass -> trim silence -> denoise -> normalize -> quality scoring.
    """
    data, sr = decode_audio_to_mono_wav(raw_path, clean_wav_path, target_sr=target_sr)
    data = highpass_filter(data, sr, cutoff_hz=75.0)
    data = trim_silence(data, sr, threshold_db=-38.0, pad_ms=80)

    # Cap extremely long samples to 28 seconds for crisp zero-shot embeddings
    max_samples = sr * 28
    if len(data) > max_samples:
        data = data[:max_samples]

    # Estimate rough SNR before denoise
    rms_all = float(np.sqrt(np.mean(data * data) + 1e-12))
    sorted_abs = np.sort(np.abs(data))
    noise_floor = float(np.mean(sorted_abs[: max(1, int(len(sorted_abs) * 0.1))]) + 1e-6)
    snr_db = float(20.0 * np.log10(max(rms_all / noise_floor, 1.0)))

    if denoise:
        data = gentle_denoise(data, sr)
    data = normalize_rms(data, target_dbfs=-18.0)

    sf.write(str(clean_wav_path), data, sr, subtype="PCM_16")

    duration = round(len(data) / sr, 2)
    pitch_hz = estimate_pitch_hz(data, sr)
    peaks = extract_waveform_peaks(data, num_bars=96)

    # Quality scoring (0-100)
    score = 60
    notes: list[str] = []
    if 3.0 <= duration <= 15.0:
        score += 25
        notes.append(f"Thời lượng lý tưởng ({duration:.1f}s)")
    elif duration < 3.0:
        score -= 10
        notes.append(f"Mẫu hơi ngắn ({duration:.1f}s, khuyến nghị 4–12s)")
    else:
        score += 18
        notes.append(f"Mẫu dài ({duration:.1f}s, đã tối ưu tự động)")

    if snr_db >= 14.0:
        score += 15
        notes.append("Âm thanh rất sạch")
    elif snr_db >= 9.0:
        score += 8
        notes.append("Âm thanh khá rõ (đã lọc nhiễu)")
    else:
        notes.append("Có tạp âm nền nhẹ (đã bật khử ồn)")

    score = max(35, min(99, score))
    return {
        "duration_sec": duration,
        "quality_score": score,
        "quality_note": " · ".join(notes),
        "pitch_hz": pitch_hz,
        "waveform_peaks": peaks,
        "sample_rate": sr,
    }


def extract_waveform_peaks(audio: np.ndarray, num_bars: int = 160) -> list[float]:
    if len(audio) == 0:
        return [0.05] * num_bars
    abs_a = np.abs(audio)
    chunk_size = max(1, len(abs_a) // num_bars)
    peaks: list[float] = []
    for i in range(num_bars):
        seg = abs_a[i * chunk_size : (i + 1) * chunk_size]
        if len(seg) == 0:
            peaks.append(0.05)
        else:
            val = float(np.percentile(seg, 92))
            peaks.append(val)
    max_p = max(peaks) if peaks else 1.0
    if max_p < 1e-6:
        max_p = 1.0
    return [round(max(0.04, min(1.0, p / max_p)), 3) for p in peaks]


def stitch_audio_chunks(
    chunks: list[tuple[np.ndarray, int, bool]],
    target_sr: int = 24000,
    pause_ms: int = 220,
    crossfade_ms: int = 45,
    normalize: bool = True,
) -> tuple[np.ndarray, int, list[tuple[float, float]]]:
    """
    Seamlessly stitch an unlimited number of audio chunks with cosine crossfade
    and natural sentence/paragraph breathing pauses.
    Returns (stitched_audio, target_sr, list_of_(start_sec, end_sec)_per_chunk).
    """
    if not chunks:
        return np.zeros(target_sr // 2, dtype=np.float32), target_sr, []

    out_parts: list[np.ndarray] = []
    timings: list[tuple[float, float]] = []
    cursor_samples = 0

    cf_samples = int(target_sr * crossfade_ms / 1000)

    for idx, (audio, sr, is_para_end) in enumerate(chunks):
        if len(audio) == 0:
            timings.append((cursor_samples / target_sr, cursor_samples / target_sr))
            continue

        a = audio.astype(np.float32)
        if a.ndim > 1:
            a = a.mean(axis=1)
        if sr != target_sr:
            a = resample_audio(a, sr, target_sr)

        # Gentle fade-in / fade-out at edges to prevent clicks
        edge = min(int(target_sr * 0.012), len(a) // 4)
        if edge > 4:
            ramp = 0.5 * (1.0 - np.cos(np.linspace(0, np.pi, edge, dtype=np.float32)))
            a[:edge] *= ramp
            a[-edge:] *= ramp[::-1]

        start_sec = cursor_samples / target_sr

        if idx > 0 and pause_ms == 0 and cf_samples > 10 and out_parts:
            prev = out_parts[-1]
            ov = min(cf_samples, len(prev) // 3, len(a) // 3)
            if ov > 4:
                fade_out = 0.5 * (1.0 + np.cos(np.linspace(0, np.pi, ov, dtype=np.float32)))
                fade_in = 1.0 - fade_out
                prev[-ov:] = prev[-ov:] * fade_out + a[:ov] * fade_in
                out_parts[-1] = prev
                a = a[ov:]
                cursor_samples -= ov
                start_sec = cursor_samples / target_sr

        out_parts.append(a)
        cursor_samples += len(a)
        end_sec = cursor_samples / target_sr
        timings.append((start_sec, end_sec))

        # Add natural silence pause between chunks (except after the last chunk)
        if idx < len(chunks) - 1 and pause_ms > 0:
            p_ms = int(pause_ms * 1.75) if is_para_end else pause_ms
            sil_len = int(target_sr * p_ms / 1000)
            if sil_len > 0:
                out_parts.append(np.zeros(sil_len, dtype=np.float32))
                cursor_samples += sil_len

    stitched = np.concatenate(out_parts) if out_parts else np.zeros(1, dtype=np.float32)
    if normalize:
        stitched = normalize_rms(stitched, target_dbfs=-20.0)
    return stitched, target_sr, timings


def save_audio_outputs(
    audio: np.ndarray,
    sr: int,
    wav_path: Path,
    mp3_path: Path | None = None,
) -> dict[str, Path | None]:
    """Save lossless WAV and fast studio-quality VBR MP3 via FFmpeg."""
    sf.write(str(wav_path), audio, sr, subtype="PCM_16")
    result: dict[str, Path | None] = {"wav": wav_path, "mp3": None}

    if mp3_path is not None:
        ffmpeg = get_ffmpeg_path()
        if ffmpeg:
            cmd = [
                ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(wav_path),
                "-codec:a",
                "libmp3lame",
                "-q:a",
                "4",
                str(mp3_path),
            ]
            proc = subprocess.run(cmd, capture_output=True)
            if proc.returncode == 0 and mp3_path.exists():
                result["mp3"] = mp3_path
    return result


def load_mp3_bytes_to_numpy(mp3_bytes: bytes, target_sr: int = 24000) -> tuple[np.ndarray, int]:
    """
    Ultra-fast in-memory MP3 -> float32 numpy decoder via FFmpeg stdio pipe
    (zero temp-directory or disk I/O overhead per chunk).
    """
    ffmpeg = get_ffmpeg_path()
    if ffmpeg:
        cmd = [
            ffmpeg,
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            "1",
            "-ar",
            str(target_sr),
            "pipe:1",
        ]
        proc = subprocess.run(cmd, input=mp3_bytes, capture_output=True)
        if proc.returncode == 0 and proc.stdout:
            arr = np.frombuffer(proc.stdout, dtype=np.float32).copy()
            if len(arr) > 0:
                return arr, target_sr

    # Fallback via temp file if pipe ever fails
    with tempfile.TemporaryDirectory() as td:
        in_p = Path(td) / "chunk.mp3"
        out_p = Path(td) / "chunk.wav"
        in_p.write_bytes(mp3_bytes)
        return decode_audio_to_mono_wav(in_p, out_p, target_sr=target_sr)


_REF_TIMBRE_CACHE: dict[str, dict[str, float]] = {}


def _band_rms_db(audio: np.ndarray, sr: int, low: float, high: float) -> float:
    nyq = sr * 0.5
    lo = max(20.0, low) / nyq
    hi = min(nyq * 0.95, high) / nyq
    if lo >= hi:
        return -60.0
    sos = signal.butter(2, [lo, hi], btype="bandpass", output="sos")
    band = signal.sosfilt(sos, audio)
    rms = float(np.sqrt(np.mean(band * band) + 1e-12))
    return float(20.0 * np.log10(max(rms, 1e-6)))


def get_cached_ref_profile(ref_path: Path, target_sr: int = 24000) -> dict[str, float]:
    """
    Cache clean acoustic tone profile (F0 pitch + low/high warmth tilt) in RAM.
    Zero STFT phase artifacts!
    """
    key = f"{ref_path.resolve()}::{target_sr}::{ref_path.stat().st_mtime_ns}"
    cached = _REF_TIMBRE_CACHE.get(key)
    if cached is not None:
        return cached
    ref_wav, ref_sr = sf.read(str(ref_path), dtype="float32", always_2d=False)
    if ref_wav.ndim > 1:
        ref_wav = ref_wav.mean(axis=1)
    if int(ref_sr) != target_sr:
        ref_wav = resample_audio(ref_wav, int(ref_sr), target_sr)
    ref_f0 = estimate_pitch_hz(ref_wav, target_sr)
    low_db = _band_rms_db(ref_wav, target_sr, 100.0, 420.0)
    mid_db = _band_rms_db(ref_wav, target_sr, 420.0, 2600.0)
    high_db = _band_rms_db(ref_wav, target_sr, 2600.0, 7500.0)
    profile = {
        "f0": ref_f0,
        "low_rel": low_db - mid_db,
        "high_rel": high_db - mid_db,
    }
    _REF_TIMBRE_CACHE[key] = profile
    return profile


def _biquad_shelf(sr: int, freq: float, gain_db: float, shelf_type: str) -> tuple[np.ndarray, np.ndarray]:
    """Clean studio audio RBJ shelf biquad filter (zero echo, zero metallic ringing)."""
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * freq / sr
    cos_w0 = np.cos(w0)
    sin_w0 = np.sin(w0)
    alpha = sin_w0 / 2.0 * np.sqrt(2.0)
    sqrt_A = np.sqrt(A)

    if shelf_type == "low":
        b0 = A * ((A + 1) - (A - 1) * cos_w0 + 2 * sqrt_A * alpha)
        b1 = 2 * A * ((A - 1) - (A + 1) * cos_w0)
        b2 = A * ((A + 1) - (A - 1) * cos_w0 - 2 * sqrt_A * alpha)
        a0 = (A + 1) + (A - 1) * cos_w0 + 2 * sqrt_A * alpha
        a1 = -2 * ((A - 1) + (A + 1) * cos_w0)
        a2 = (A + 1) + (A - 1) * cos_w0 - 2 * sqrt_A * alpha
    else:
        b0 = A * ((A + 1) + (A - 1) * cos_w0 + 2 * sqrt_A * alpha)
        b1 = -2 * A * ((A - 1) + (A + 1) * cos_w0)
        b2 = A * ((A + 1) + (A - 1) * cos_w0 - 2 * sqrt_A * alpha)
        a0 = (A + 1) - (A - 1) * cos_w0 + 2 * sqrt_A * alpha
        a1 = 2 * ((A - 1) - (A + 1) * cos_w0)
        a2 = (A + 1) - (A - 1) * cos_w0 - 2 * sqrt_A * alpha

    return np.array([b0 / a0, b1 / a0, b2 / a0], dtype=np.float64), np.array(
        [1.0, a1 / a0, a2 / a0], dtype=np.float64
    )


def apply_clean_tone_match(
    source_audio: np.ndarray,
    source_sr: int,
    ref_profile: dict[str, float],
    strength: float = 0.8,
) -> np.ndarray:
    """
    Studio-clean 2-band shelving tone matcher (warmth & brightness matching).
    Completely free of STFT phase-vocoder echo, buzz, or metallic distortion!
    """
    if len(source_audio) < 512:
        return source_audio
    out = source_audio.astype(np.float64)
    src_low = _band_rms_db(source_audio, source_sr, 100.0, 420.0)
    src_mid = _band_rms_db(source_audio, source_sr, 420.0, 2600.0)
    src_high = _band_rms_db(source_audio, source_sr, 2600.0, 7500.0)

    low_diff = float(np.clip((ref_profile["low_rel"] - (src_low - src_mid)) * strength * 0.45, -3.5, 3.5))
    high_diff = float(np.clip((ref_profile["high_rel"] - (src_high - src_mid)) * strength * 0.45, -3.5, 3.5))

    if abs(low_diff) > 0.35:
        b, a = _biquad_shelf(source_sr, 260.0, low_diff, "low")
        out = signal.lfilter(b, a, out)
    if abs(high_diff) > 0.35:
        b, a = _biquad_shelf(source_sr, 3600.0, high_diff, "high")
        out = signal.lfilter(b, a, out)

    return normalize_rms(out.astype(np.float32), target_dbfs=-20.0)
