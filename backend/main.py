from __future__ import annotations

import asyncio
import re
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from pydantic import BaseModel

from backend.config import (
    FRONTEND_DIST,
    OUTPUTS_DIR,
    VOICES_DIR,
    get_ffmpeg_path,
    get_hf_token,
    save_settings,
)
from backend.engines.edge_engine import edge_engine
from backend.engines.gpu_clone_engine import f5_gpu_engine, zipvoice_gpu_engine
from backend.engines.hybrid_clone_engine import hybrid_clone_engine
from backend.engines.kokoro_engine import kokoro_engine
from backend.engines.vieneu_engine import vieneu_engine
from backend.engines.vizipvoice_engine import vizipvoice_engine
from backend.job_manager import job_manager
from backend.models import DialogueRequest, SynthesizeRequest
from backend.voice_vault import voice_vault

app = FastAPI(
    title="VOXFORGE STUDIO API",
    description="Multi-Engine Unlimited TTS & Zero-Shot Voice Cloning Studio",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount generated outputs & cloned voice samples
app.mount("/media/voices", StaticFiles(directory=str(VOICES_DIR)), name="media_voices")
app.mount("/media/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="media_outputs")


@app.on_event("startup")
async def prewarm_engines():
    """Pre-warm Edge voice list & local ViZipVoice ONNX INT8 in background so first clone is fast."""
    async def _warm():
        try:
            await edge_engine.list_voices()
        except Exception:
            pass
        try:
            if vizipvoice_engine.is_ready():
                await vizipvoice_engine.prepare_model()
        except Exception:
            pass

    asyncio.create_task(_warm())


class SettingsPayload(BaseModel):
    hf_token: str = ""


@app.get("/api/settings")
async def get_settings_api():
    tok = get_hf_token() or ""
    masked = f"{tok[:6]}…{tok[-4:]}" if len(tok) > 12 else ("Đã lưu" if tok else "")
    return {"has_hf_token": bool(tok), "hf_token_masked": masked}


@app.post("/api/settings")
async def update_settings_api(payload: SettingsPayload):
    save_settings({"hf_token": payload.hf_token.strip()})
    zipvoice_gpu_engine.reset_cooldown()
    f5_gpu_engine.reset_cooldown()
    tok = get_hf_token() or ""
    masked = f"{tok[:6]}…{tok[-4:]}" if len(tok) > 12 else ("Đã lưu" if tok else "")
    return {"has_hf_token": bool(tok), "hf_token_masked": masked}


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "ffmpeg": bool(get_ffmpeg_path()),
        "cloned_voices": len(voice_vault.list_voices()),
        "history_count": len(job_manager.list_history()),
    }


@app.get("/api/engines")
async def list_engines():
    return {
        "engines": [
            edge_engine.get_status(),
            vizipvoice_engine.get_status(),
            zipvoice_gpu_engine.get_status(),
            f5_gpu_engine.get_status(),
            vieneu_engine.get_status(),
            kokoro_engine.get_status(),
        ],
        "ffmpeg_ready": bool(get_ffmpeg_path()),
    }


@app.post("/api/engines/{engine_id}/prepare")
async def prepare_engine(engine_id: str, background_tasks: BackgroundTasks):
    if engine_id == "kokoro":
        if not kokoro_engine.is_package_installed():
            raise HTTPException(400, "Gói kokoro-onnx chưa được cài đặt.")
        if kokoro_engine.is_model_downloaded():
            return {"status": "ready", "message": "Kokoro-82M ONNX đã sẵn sàng!"}
        background_tasks.add_task(kokoro_engine.download_models)
        return {"status": "downloading", "message": "Đang tải Kokoro-82M ONNX trong nền..."}

    if engine_id == "vieneu":
        if not vieneu_engine.is_package_installed():
            raise HTTPException(400, "Gói vieneu chưa được cài đặt.")
        if vieneu_engine.is_loaded():
            return {"status": "ready", "message": "VieNeu-TTS v3 Nano đã sẵn sàng!"}
        background_tasks.add_task(vieneu_engine.prepare_model)
        return {
            "status": "loading",
            "message": "Đang tải & khởi tạo VieNeu-TTS v3 Nano ONNX trong nền...",
        }

    return {"status": "ready", "message": f"Engine '{engine_id}' đã sẵn sàng!"}


@app.get("/api/voices/stock")
async def get_stock_voices(engine: str = "edge"):
    if engine == "edge" or engine == "hybrid_clone":
        voices = await edge_engine.list_voices()
        return {"voices": [v.model_dump() for v in voices]}
    if engine == "vieneu":
        return {"voices": [v.model_dump() for v in vieneu_engine.list_voices()]}
    if engine == "kokoro":
        return {"voices": [v.model_dump() for v in kokoro_engine.list_voices()]}
    raise HTTPException(400, f"Unknown engine: {engine}")


@app.get("/api/voices/cloned")
async def get_cloned_voices():
    return {"voices": [v.model_dump() for v in voice_vault.list_voices()]}


@app.post("/api/voices/cloned")
async def create_cloned_voice(
    file: UploadFile = File(...),
    name: str = Form(...),
    language: str = Form("vi"),
    gender: str = Form("neutral"),
    description: str = Form(""),
    tags: str = Form(""),
    ref_text: str = Form(""),
    denoise: bool = Form(True),
):
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(400, "File âm thanh trống.")
    if len(raw_bytes) > 60 * 1024 * 1024:
        raise HTTPException(400, "File mẫu tối đa 60MB.")

    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    try:
        profile = await asyncio.to_thread(
            voice_vault.create_voice,
            raw_bytes,
            file.filename or "sample.wav",
            name,
            language,
            gender,
            description,
            tag_list,
            ref_text,
            denoise,
        )
        return profile.model_dump()
    except Exception as exc:
        raise HTTPException(400, f"Không thể xử lý file mẫu giọng nói: {exc}")


@app.delete("/api/voices/cloned/{voice_id}")
async def delete_cloned_voice(voice_id: str):
    ok = voice_vault.delete_voice(voice_id)
    if not ok:
        raise HTTPException(404, "Không tìm thấy giọng clone.")
    vieneu_engine.invalidate_cache(voice_id)
    return {"deleted": True}


@app.post("/api/text/extract")
async def extract_text(file: UploadFile = File(...)):
    raw = await file.read()
    fname = file.filename or "document.txt"
    ext = Path(fname).suffix.lower()

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")

    # Strip SRT / VTT timestamps automatically if subtitle file imported
    if ext in (".srt", ".vtt"):
        lines = []
        for line in text.splitlines():
            s = line.strip()
            if not s or s == "WEBVTT" or s.isdigit() or "-->" in s:
                continue
            lines.append(re.sub(r"<[^>]+>", "", s))
        text = "\n".join(lines)

    return {"filename": fname, "text": text, "char_count": len(text)}


@app.post("/api/tts/synthesize")
async def synthesize_tts(req: SynthesizeRequest):
    try:
        job = await job_manager.start_single_job(req)
        return job.model_dump()
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.post("/api/tts/dialogue")
async def synthesize_dialogue(req: DialogueRequest):
    try:
        job = await job_manager.start_dialogue_job(req)
        return job.model_dump()
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(404, "Không tìm thấy tiến trình.")
    return job.model_dump()


@app.get("/api/jobs/{job_id}/events")
async def stream_job_events(job_id: str):
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(404, "Không tìm thấy tiến trình.")
    return StreamingResponse(
        job_manager.subscribe(job_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    ok = job_manager.cancel_job(job_id)
    return {"cancelled": ok}


@app.get("/api/history")
async def get_history():
    return {"jobs": [j.model_dump() for j in job_manager.list_history()]}


@app.post("/api/history/{job_id}/favorite")
async def toggle_favorite(job_id: str):
    job = job_manager.toggle_favorite(job_id)
    if not job:
        raise HTTPException(404, "Không tìm thấy bản ghi.")
    return job.model_dump()


@app.delete("/api/history/{job_id}")
async def delete_history(job_id: str):
    ok = job_manager.delete_job(job_id)
    if not ok:
        raise HTTPException(404, "Không tìm thấy bản ghi.")
    return {"deleted": True}


# Serve built React frontend in production mode
if FRONTEND_DIST.exists() and (FRONTEND_DIST / "index.html").exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="frontend_assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        target = FRONTEND_DIST / full_path
        if full_path and target.exists() and target.is_file():
            return FileResponse(str(target))
        return FileResponse(str(FRONTEND_DIST / "index.html"))
