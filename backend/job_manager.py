from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncGenerator

import numpy as np

from backend.audio_utils import (
    extract_waveform_peaks,
    save_audio_outputs,
    stitch_audio_chunks,
)
from backend.config import HISTORY_FILE, OUTPUTS_DIR
from backend.engines.edge_engine import edge_engine
from backend.engines.gpu_clone_engine import f5_gpu_engine, zipvoice_gpu_engine
from backend.engines.hybrid_clone_engine import hybrid_clone_engine
from backend.engines.kokoro_engine import kokoro_engine
from backend.engines.vieneu_engine import vieneu_engine
from backend.engines.vizipvoice_engine import vizipvoice_engine
from backend.models import (
    ChunkProgress,
    DialogueRequest,
    JobRecord,
    SynthesizeRequest,
)
from backend.text_processor import build_subtitles, smart_chunk_text
from backend.voice_vault import voice_vault


class JobManager:
    """
    High-speed parallel async orchestrator for unlimited-character single-voice TTS
    and multi-speaker dialogue synthesis with live SSE progress updates.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, JobRecord] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._cancelled: set[str] = set()
        self._subscribers: dict[str, list[asyncio.Queue[str]]] = {}
        self._load_history()

    def _load_history(self) -> None:
        if not HISTORY_FILE.exists():
            return
        try:
            raw = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            for item in raw:
                job = JobRecord(**item)
                if job.status in ("queued", "running", "stitching"):
                    job.status = "error"
                    job.error = "Tiến trình bị gián đoạn khi khởi động lại server."
                self._jobs[job.job_id] = job
        except Exception:
            self._jobs = {}

    def _save_history(self) -> None:
        items = [j.model_dump() for j in self.list_history()[:150]]
        HISTORY_FILE.write_text(
            json.dumps(items, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def list_history(self) -> list[JobRecord]:
        return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)

    def get_job(self, job_id: str) -> JobRecord | None:
        return self._jobs.get(job_id)

    def toggle_favorite(self, job_id: str) -> JobRecord | None:
        job = self._jobs.get(job_id)
        if not job:
            return None
        job.favorite = not job.favorite
        self._save_history()
        return job

    def delete_job(self, job_id: str) -> bool:
        self.cancel_job(job_id)
        job = self._jobs.pop(job_id, None)
        if not job:
            return False
        for ext in ("mp3", "wav", "srt", "vtt"):
            p = OUTPUTS_DIR / f"{job_id}.{ext}"
            if p.exists():
                try:
                    p.unlink()
                except Exception:
                    pass
        self._save_history()
        return True

    def cancel_job(self, job_id: str) -> bool:
        if job_id not in self._jobs:
            return False
        self._cancelled.add(job_id)
        task = self._tasks.get(job_id)
        if task and not task.done():
            task.cancel()
        job = self._jobs[job_id]
        if job.status in ("queued", "running", "stitching"):
            job.status = "cancelled"
            job.error = "Đã hủy bởi người dùng."
            self._emit(job)
            self._save_history()
        return True

    def _emit(self, job: JobRecord) -> None:
        payload = job.model_dump_json()
        for q in list(self._subscribers.get(job.job_id, [])):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    async def subscribe(self, job_id: str) -> AsyncGenerator[str, None]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
        self._subscribers.setdefault(job_id, []).append(q)
        try:
            job = self._jobs.get(job_id)
            if job:
                yield f"data: {job.model_dump_json()}\n\n"
                if job.status in ("completed", "error", "cancelled"):
                    return
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {data}\n\n"
                    parsed = json.loads(data)
                    if parsed.get("status") in ("completed", "error", "cancelled"):
                        break
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    cur = self._jobs.get(job_id)
                    if not cur or cur.status in ("completed", "error", "cancelled"):
                        break
        finally:
            subs = self._subscribers.get(job_id, [])
            if q in subs:
                subs.remove(q)

    def _resolve_chunk_size(self, engine: str) -> int:
        if engine == "vizipvoice":
            return 160
        if engine == "zipvoice_gpu":
            return 260
        if engine == "f5_gpu":
            return 300
        if engine == "vieneu":
            return 240
        if engine == "kokoro":
            return 420
        if engine == "hybrid_clone":
            return 950
        return 1000

    def _resolve_concurrency(self, engine: str) -> int:
        if engine == "edge":
            return 4
        if engine == "hybrid_clone":
            return 4
        return 1  # ONNX CPU & ZeroGPU Spaces perform best sequentially without queueing contention

    async def start_single_job(self, req: SynthesizeRequest) -> JobRecord:
        job_id = f"vox_{uuid.uuid4().hex[:10]}"
        max_chars = self._resolve_chunk_size(req.engine)
        text_chunks = smart_chunk_text(req.text, max_chars=max_chars)
        if not text_chunks:
            raise ValueError("Văn bản trống sau khi làm sạch.")

        voice_label = req.voice_id
        if req.cloned_voice_id:
            profile = voice_vault.get_voice(req.cloned_voice_id)
            if not profile:
                raise ValueError("Không tìm thấy giọng clone đã chọn trong Kho giọng Clone.")
            voice_label = f"Clone · {profile.name}"
        elif req.engine == "kokoro" and req.blend_voice_id:
            pct = int(round(req.blend_ratio * 100))
            voice_label = f"Blend {pct}% {req.voice_id} + {100 - pct}% {req.blend_voice_id}"

        clean_title = req.title.strip() or (
            req.text.strip().splitlines()[0][:48] + ("…" if len(req.text.strip()) > 48 else "")
        )

        chunk_models = [
            ChunkProgress(
                index=c.index,
                text_preview=c.text[:95] + ("…" if len(c.text) > 95 else ""),
                char_count=len(c.text),
                status="queued",
            )
            for c in text_chunks
        ]

        job = JobRecord(
            job_id=job_id,
            title=clean_title,
            mode="single",
            status="queued",
            progress=0.0,
            current_chunk=0,
            total_chunks=len(text_chunks),
            chunks=chunk_models,
            engine=req.engine,
            voice_name=voice_label,
            cloned_voice_id=req.cloned_voice_id,
            char_count=len(req.text),
            word_count=len(req.text.split()),
            output_format=req.output_format,
            text_preview=req.text.strip()[:260],
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self._jobs[job_id] = job
        self._save_history()

        task = asyncio.create_task(self._run_single_job(job, req, text_chunks))
        self._tasks[job_id] = task
        return job

    async def _run_single_job(
        self,
        job: JobRecord,
        req: SynthesizeRequest,
        text_chunks: list,
    ) -> None:
        target_sr = 24000
        try:
            job.status = "running"
            self._emit(job)

            ref_path: Path | None = None
            cloned_gender = "neutral"
            cloned_ref_text = ""
            cloned_lang = "vi"
            if req.cloned_voice_id:
                ref_path = voice_vault.get_audio_path(req.cloned_voice_id)
                profile = voice_vault.get_voice(req.cloned_voice_id)
                if profile:
                    cloned_gender = profile.gender
                    cloned_ref_text = profile.ref_text
                    cloned_lang = profile.language
                if not ref_path:
                    raise RuntimeError("File âm thanh gốc của giọng clone không còn tồn tại.")

            hybrid_base_voice = req.voice_id
            if req.engine == "hybrid_clone" and not hybrid_base_voice.endswith("Neural"):
                hybrid_base_voice = (
                    "vi-VN-NamMinhNeural" if cloned_gender == "male" else "vi-VN-HoaiMyNeural"
                )

            total = len(text_chunks)
            concurrency = self._resolve_concurrency(req.engine)
            sem = asyncio.Semaphore(concurrency)

            results: list[tuple[np.ndarray, int, bool] | None] = [None] * total
            chunk_word_events: list[list[dict[str, Any]]] = [[] for _ in range(total)]
            completed_count = 0

            async def _process_one(idx: int, tc: Any) -> None:
                nonlocal completed_count
                async with sem:
                    if job.job_id in self._cancelled:
                        return
                    job.chunks[idx].status = "processing"
                    job.current_chunk = max(job.current_chunk, idx + 1)
                    self._emit(job)

                    boundaries: list[dict[str, Any]] = []
                    if req.engine == "edge":
                        wav, sr, boundaries = await edge_engine.synthesize_chunk(
                            text=tc.text,
                            voice_id=req.voice_id,
                            speed=req.speed,
                            pitch=req.pitch,
                            volume=req.volume,
                            target_sr=target_sr,
                        )
                    elif req.engine == "vizipvoice":
                        if not ref_path:
                            raise RuntimeError("Vui lòng chọn 1 giọng clone để dùng ViZipVoice 7000h.")
                        wav, sr, resolved_ref = await vizipvoice_engine.synthesize_chunk(
                            text=tc.text,
                            ref_audio_path=ref_path,
                            ref_text=cloned_ref_text,
                            language=cloned_lang,
                            speed=req.speed,
                            quality_mode=req.quality_mode,
                        )
                        if resolved_ref and not cloned_ref_text and req.cloned_voice_id:
                            cloned_ref_text = resolved_ref
                            voice_vault.update_voice(req.cloned_voice_id, {"ref_text": resolved_ref})
                    elif req.engine == "zipvoice_gpu":
                        if not ref_path:
                            raise RuntimeError("Vui lòng chọn 1 giọng clone để dùng ZipVoice GPU.")
                        wav, sr, resolved_ref = await zipvoice_gpu_engine.synthesize_chunk(
                            text=tc.text,
                            ref_audio_path=ref_path,
                            ref_text=cloned_ref_text,
                            language=cloned_lang,
                            speed=req.speed,
                            quality_mode=req.quality_mode,
                        )
                        if resolved_ref and not cloned_ref_text and req.cloned_voice_id:
                            cloned_ref_text = resolved_ref
                            voice_vault.update_voice(req.cloned_voice_id, {"ref_text": resolved_ref})
                    elif req.engine == "f5_gpu":
                        if not ref_path:
                            raise RuntimeError("Vui lòng chọn 1 giọng clone để dùng F5-TTS Việt Nam.")
                        wav, sr, resolved_ref = await f5_gpu_engine.synthesize_chunk(
                            text=tc.text,
                            ref_audio_path=ref_path,
                            ref_text=cloned_ref_text,
                            language=cloned_lang,
                            speed=req.speed,
                            quality_mode=req.quality_mode,
                        )
                        if resolved_ref and not cloned_ref_text and req.cloned_voice_id:
                            cloned_ref_text = resolved_ref
                            voice_vault.update_voice(req.cloned_voice_id, {"ref_text": resolved_ref})
                    elif req.engine == "vieneu":
                        wav, sr = await vieneu_engine.synthesize_chunk(
                            text=tc.text,
                            voice_id=req.voice_id,
                            cloned_voice_id=req.cloned_voice_id,
                            ref_audio_path=ref_path,
                            speed=req.speed,
                            quality_mode=req.quality_mode,
                        )
                    elif req.engine == "kokoro":
                        wav, sr = await kokoro_engine.synthesize_chunk(
                            text=tc.text,
                            voice_id=req.voice_id,
                            speed=req.speed,
                            blend_voice_id=req.blend_voice_id,
                            blend_ratio=req.blend_ratio,
                        )
                    elif req.engine == "hybrid_clone":
                        if not ref_path:
                            raise RuntimeError("Vui lòng chọn 1 giọng clone trước khi dùng Hybrid Clone.")
                        wav, sr, boundaries = await hybrid_clone_engine.synthesize_chunk(
                            text=tc.text,
                            ref_audio_path=ref_path,
                            base_voice_id=hybrid_base_voice,
                            speed=req.speed,
                            pitch=req.pitch,
                            volume=req.volume,
                            clone_strength=req.clone_strength,
                            target_sr=target_sr,
                        )
                    else:
                        raise RuntimeError(f"Engine không hợp lệ: {req.engine}")

                    dur = round(len(wav) / max(sr, 1), 2)
                    results[idx] = (wav, sr, tc.is_paragraph_end)
                    chunk_word_events[idx] = boundaries
                    completed_count += 1

                    job.chunks[idx].status = "done"
                    job.chunks[idx].duration_sec = dur
                    job.current_chunk = completed_count
                    job.progress = round((completed_count / total) * 90.0, 1)
                    self._emit(job)

            if concurrency > 1 and total > 1:
                await asyncio.gather(*[_process_one(i, tc) for i, tc in enumerate(text_chunks)])
            else:
                for i, tc in enumerate(text_chunks):
                    if job.job_id in self._cancelled:
                        return
                    await _process_one(i, tc)

            if job.job_id in self._cancelled:
                return

            audio_chunks = [r for r in results if r is not None]

            # Stitching & Studio Mastering
            job.status = "stitching"
            job.progress = 94.0
            self._emit(job)

            stitched, out_sr, timings = await asyncio.to_thread(
                stitch_audio_chunks,
                audio_chunks,
                target_sr,
                req.pause_ms,
                req.crossfade_ms,
                req.normalize_audio,
            )

            wav_path = OUTPUTS_DIR / f"{job.job_id}.wav"
            mp3_path = OUTPUTS_DIR / f"{job.job_id}.mp3" if req.output_format == "mp3" else None
            saved = await asyncio.to_thread(save_audio_outputs, stitched, out_sr, wav_path, mp3_path)

            peaks = await asyncio.to_thread(extract_waveform_peaks, stitched, 160)
            duration_sec = round(len(stitched) / out_sr, 2)

            srt_url: str | None = None
            vtt_url: str | None = None
            if req.generate_subtitles:
                segments: list[tuple[float, float, str]] = []
                for idx, ((c_start, c_end), tc) in enumerate(zip(timings, text_chunks)):
                    ev = chunk_word_events[idx] if idx < len(chunk_word_events) else []
                    word_ev = [e for e in ev if e.get("type") == "WordBoundary" and e.get("text")]
                    if word_ev:
                        group_size = 10
                        for g in range(0, len(word_ev), group_size):
                            batch = word_ev[g : g + group_size]
                            s_t = c_start + batch[0]["start"]
                            e_t = min(c_end, c_start + batch[-1]["end"])
                            caption = " ".join(x["text"] for x in batch)
                            segments.append((s_t, max(s_t + 0.15, e_t), caption))
                    else:
                        segments.append((c_start, max(c_start + 0.2, c_end), tc.text))

                srt_text, vtt_text = build_subtitles(segments)
                (OUTPUTS_DIR / f"{job.job_id}.srt").write_text(srt_text, encoding="utf-8")
                (OUTPUTS_DIR / f"{job.job_id}.vtt").write_text(vtt_text, encoding="utf-8")
                srt_url = f"/media/outputs/{job.job_id}.srt"
                vtt_url = f"/media/outputs/{job.job_id}.vtt"

            primary_is_mp3 = saved.get("mp3") is not None
            job.output_format = "mp3" if primary_is_mp3 else "wav"
            job.audio_url = f"/media/outputs/{job.job_id}.{'mp3' if primary_is_mp3 else 'wav'}"
            job.wav_url = f"/media/outputs/{job.job_id}.wav"
            job.subtitle_srt_url = srt_url
            job.subtitle_vtt_url = vtt_url
            job.waveform_peaks = peaks
            job.duration_sec = duration_sec
            job.progress = 100.0
            job.status = "completed"
            self._emit(job)
            self._save_history()

        except asyncio.CancelledError:
            job.status = "cancelled"
            job.error = "Đã hủy bởi người dùng."
            self._emit(job)
            self._save_history()
        except Exception as exc:
            job.status = "error"
            job.error = str(exc)
            for ch in job.chunks:
                if ch.status == "processing":
                    ch.status = "error"
            self._emit(job)
            self._save_history()
        finally:
            self._tasks.pop(job.job_id, None)
            self._cancelled.discard(job.job_id)

    async def start_dialogue_job(self, req: DialogueRequest) -> JobRecord:
        job_id = f"pod_{uuid.uuid4().hex[:10]}"
        total_chars = sum(len(ln.text) for ln in req.lines)
        total_words = sum(len(ln.text.split()) for ln in req.lines)

        chunk_models = [
            ChunkProgress(
                index=i,
                text_preview=ln.text[:95] + ("…" if len(ln.text) > 95 else ""),
                char_count=len(ln.text),
                status="queued",
                speaker=ln.speaker,
            )
            for i, ln in enumerate(req.lines)
        ]

        speakers = list(dict.fromkeys(ln.speaker for ln in req.lines))
        job = JobRecord(
            job_id=job_id,
            title=req.title.strip() or "Multi-Speaker Podcast",
            mode="dialogue",
            status="queued",
            progress=0.0,
            current_chunk=0,
            total_chunks=len(req.lines),
            chunks=chunk_models,
            engine="multi",
            voice_name=" · ".join(speakers[:3]) + ("…" if len(speakers) > 3 else ""),
            char_count=total_chars,
            word_count=total_words,
            output_format=req.output_format,
            text_preview=" | ".join(f"{ln.speaker}: {ln.text[:55]}" for ln in req.lines[:3]),
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self._jobs[job_id] = job
        self._save_history()

        task = asyncio.create_task(self._run_dialogue_job(job, req))
        self._tasks[job_id] = task
        return job

    async def _run_dialogue_job(self, job: JobRecord, req: DialogueRequest) -> None:
        target_sr = 24000
        try:
            job.status = "running"
            self._emit(job)

            total = len(req.lines)
            line_wavs: list[np.ndarray | None] = [None] * total
            net_sem = asyncio.Semaphore(4)
            local_lock = asyncio.Lock()
            completed = 0

            async def _synth_line(idx: int, ln: Any) -> None:
                nonlocal completed
                is_local = ln.engine in ("vizipvoice", "zipvoice_gpu", "f5_gpu", "vieneu", "kokoro")
                if is_local:
                    ctx_mgr = local_lock
                else:
                    ctx_mgr = net_sem

                async with ctx_mgr:
                    if job.job_id in self._cancelled:
                        return
                    job.chunks[idx].status = "processing"
                    self._emit(job)

                    sub_chunks = smart_chunk_text(ln.text, max_chars=self._resolve_chunk_size(ln.engine))
                    ref_path = voice_vault.get_audio_path(ln.cloned_voice_id) if ln.cloned_voice_id else None
                    line_audio_parts: list[tuple[np.ndarray, int, bool]] = []

                    for sc in sub_chunks:
                        if ln.engine == "edge":
                            w, sr, _ = await edge_engine.synthesize_chunk(
                                text=sc.text,
                                voice_id=ln.voice_id,
                                speed=ln.speed,
                                pitch=ln.pitch,
                                target_sr=target_sr,
                            )
                        elif ln.engine == "vizipvoice":
                            if not ref_path:
                                raise RuntimeError(f"Dòng {idx + 1} ({ln.speaker}) chưa chọn giọng clone.")
                            prof = voice_vault.get_voice(ln.cloned_voice_id) if ln.cloned_voice_id else None
                            w, sr, _ = await vizipvoice_engine.synthesize_chunk(
                                text=sc.text,
                                ref_audio_path=ref_path,
                                ref_text=prof.ref_text if prof else "",
                                language=prof.language if prof else "vi",
                                speed=ln.speed,
                            )
                        elif ln.engine == "zipvoice_gpu":
                            if not ref_path:
                                raise RuntimeError(f"Dòng {idx + 1} ({ln.speaker}) chưa chọn giọng clone.")
                            prof = voice_vault.get_voice(ln.cloned_voice_id) if ln.cloned_voice_id else None
                            w, sr, _ = await zipvoice_gpu_engine.synthesize_chunk(
                                text=sc.text,
                                ref_audio_path=ref_path,
                                ref_text=prof.ref_text if prof else "",
                                language=prof.language if prof else "vi",
                                speed=ln.speed,
                            )
                        elif ln.engine == "f5_gpu":
                            if not ref_path:
                                raise RuntimeError(f"Dòng {idx + 1} ({ln.speaker}) chưa chọn giọng clone.")
                            prof = voice_vault.get_voice(ln.cloned_voice_id) if ln.cloned_voice_id else None
                            w, sr, _ = await f5_gpu_engine.synthesize_chunk(
                                text=sc.text,
                                ref_audio_path=ref_path,
                                ref_text=prof.ref_text if prof else "",
                                language=prof.language if prof else "vi",
                                speed=ln.speed,
                            )
                        elif ln.engine == "vieneu":
                            w, sr = await vieneu_engine.synthesize_chunk(
                                text=sc.text,
                                voice_id=ln.voice_id,
                                cloned_voice_id=ln.cloned_voice_id,
                                ref_audio_path=ref_path,
                                speed=ln.speed,
                                quality_mode="turbo",
                            )
                        elif ln.engine == "kokoro":
                            w, sr = await kokoro_engine.synthesize_chunk(
                                text=sc.text,
                                voice_id=ln.voice_id,
                                speed=ln.speed,
                            )
                        elif ln.engine == "hybrid_clone":
                            if not ref_path:
                                raise RuntimeError(f"Dòng {idx + 1} ({ln.speaker}) chưa chọn giọng clone.")
                            base_v = ln.voice_id if ln.voice_id.endswith("Neural") else "vi-VN-HoaiMyNeural"
                            w, sr, _ = await hybrid_clone_engine.synthesize_chunk(
                                text=sc.text,
                                ref_audio_path=ref_path,
                                base_voice_id=base_v,
                                speed=ln.speed,
                                pitch=ln.pitch,
                                target_sr=target_sr,
                            )
                        else:
                            raise RuntimeError(f"Engine không hỗ trợ: {ln.engine}")
                        line_audio_parts.append((w, sr, sc.is_paragraph_end))

                    line_wav, out_sr, _ = await asyncio.to_thread(
                        stitch_audio_chunks,
                        line_audio_parts,
                        target_sr,
                        160,
                        35,
                        True,
                    )
                    line_wavs[idx] = line_wav
                    completed += 1
                    job.chunks[idx].status = "done"
                    job.chunks[idx].duration_sec = round(len(line_wav) / out_sr, 2)
                    job.current_chunk = completed
                    job.progress = round((completed / total) * 92.0, 1)
                    self._emit(job)

            await asyncio.gather(*[_synth_line(i, ln) for i, ln in enumerate(req.lines)])

            if job.job_id in self._cancelled:
                return

            parts: list[np.ndarray] = []
            segments: list[tuple[float, float, str]] = []
            cursor_samples = 0

            for idx, ln in enumerate(req.lines):
                lw = line_wavs[idx]
                if lw is None:
                    continue
                start_sec = cursor_samples / target_sr
                parts.append(lw)
                cursor_samples += len(lw)
                end_sec = cursor_samples / target_sr
                segments.append((start_sec, end_sec, f"[{ln.speaker}] {ln.text.strip()}"))

                if idx < total - 1 and ln.pause_after_ms > 0:
                    sil = np.zeros(int(target_sr * ln.pause_after_ms / 1000), dtype=np.float32)
                    parts.append(sil)
                    cursor_samples += len(sil)

            job.status = "stitching"
            job.progress = 95.0
            self._emit(job)

            full_audio = np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32)
            wav_path = OUTPUTS_DIR / f"{job.job_id}.wav"
            mp3_path = OUTPUTS_DIR / f"{job.job_id}.mp3" if req.output_format == "mp3" else None
            saved = await asyncio.to_thread(save_audio_outputs, full_audio, target_sr, wav_path, mp3_path)
            peaks = await asyncio.to_thread(extract_waveform_peaks, full_audio, 160)

            srt_url = vtt_url = None
            if req.generate_subtitles:
                srt_text, vtt_text = build_subtitles(segments)
                (OUTPUTS_DIR / f"{job.job_id}.srt").write_text(srt_text, encoding="utf-8")
                (OUTPUTS_DIR / f"{job.job_id}.vtt").write_text(vtt_text, encoding="utf-8")
                srt_url = f"/media/outputs/{job.job_id}.srt"
                vtt_url = f"/media/outputs/{job.job_id}.vtt"

            primary_is_mp3 = saved.get("mp3") is not None
            job.output_format = "mp3" if primary_is_mp3 else "wav"
            job.audio_url = f"/media/outputs/{job.job_id}.{'mp3' if primary_is_mp3 else 'wav'}"
            job.wav_url = f"/media/outputs/{job.job_id}.wav"
            job.subtitle_srt_url = srt_url
            job.subtitle_vtt_url = vtt_url
            job.waveform_peaks = peaks
            job.duration_sec = round(len(full_audio) / target_sr, 2)
            job.progress = 100.0
            job.status = "completed"
            self._emit(job)
            self._save_history()

        except asyncio.CancelledError:
            job.status = "cancelled"
            job.error = "Đã hủy bởi người dùng."
            self._emit(job)
            self._save_history()
        except Exception as exc:
            job.status = "error"
            job.error = str(exc)
            self._emit(job)
            self._save_history()
        finally:
            self._tasks.pop(job.job_id, None)
            self._cancelled.discard(job.job_id)


job_manager = JobManager()
