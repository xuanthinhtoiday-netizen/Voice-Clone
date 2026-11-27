import {
  base64ToUint8,
  blobToBase64,
  preprocessReferenceAudio,
  smartChunkText,
  stitchAudioChunks,
  type DecodedChunkAudio,
  type WordBoundary,
} from './clientAudio';
import {
  getLocalHfToken,
  localVault,
  maskToken,
  setLocalHfToken,
} from './localVault';
import type {
  ChunkProgress,
  ClonedVoiceProfile,
  DialoguePayload,
  EngineStatus,
  JobRecord,
  StockVoiceInfo,
  SynthesizePayload,
} from './types';

type BackendRuntime = 'cloudflare-hono' | 'python-local';

let runtimePromise: Promise<BackendRuntime> | null = null;
let cachedRuntime: BackendRuntime | null = null;

function buildHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const hfToken = getLocalHfToken();
  if (hfToken && !headers.has('X-HF-Token')) {
    headers.set('X-HF-Token', hfToken);
  }
  return headers;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: buildHeaders(init?.headers),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      detail = data.detail || data.message || detail;
    } catch {
      const txt = await res.text();
      if (txt) detail = txt.slice(0, 240);
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export async function detectRuntime(): Promise<BackendRuntime> {
  if (cachedRuntime) return cachedRuntime;
  if (!runtimePromise) {
    runtimePromise = fetch('/api/health')
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: { runtime?: string }) => {
        cachedRuntime = data?.runtime === 'cloudflare-hono' ? 'cloudflare-hono' : 'python-local';
        return cachedRuntime;
      })
      .catch(() => {
        cachedRuntime = 'python-local';
        return cachedRuntime;
      });
  }
  return runtimePromise;
}

// ---------------- Client-Side Cloud Job Orchestrator ----------------

interface ActiveCloudJob {
  record: JobRecord;
  controller: AbortController;
  listeners: Set<(job: JobRecord) => void>;
}

const cloudJobs = new Map<string, ActiveCloudJob>();

function emitCloudJob(jobId: string) {
  const entry = cloudJobs.get(jobId);
  if (!entry) return;
  const snapshot: JobRecord = {
    ...entry.record,
    chunks: entry.record.chunks.map((c) => ({ ...c })),
  };
  for (const fn of entry.listeners) {
    try {
      fn(snapshot);
    } catch {
      // ignore listener error
    }
  }
}

function makeJobId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

async function fetchEdgeChunkWithRetry(
  args: {
    text: string;
    voice_id: string;
    speed: number;
    pitch: number;
    volume: number;
  },
  signal: AbortSignal
): Promise<{ bytes: Uint8Array; durationSec: number; boundaries: WordBoundary[] }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new Error('Đã hủy tiến trình.');
    try {
      const data = await apiFetch<{
        audio_base64: string;
        mime_type: string;
        duration_sec: number;
        boundaries: WordBoundary[];
      }>('/api/tts/edge-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal,
      });
      return {
        bytes: base64ToUint8(data.audio_base64),
        durationSec: data.duration_sec || 0,
        boundaries: data.boundaries || [],
      };
    } catch (err) {
      if (signal.aborted) throw new Error('Đã hủy tiến trình.');
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Lỗi kết nối Edge-TTS Worker.');
}

async function fetchCloneChunkWithRetry(
  args: {
    engine: string;
    text: string;
    ref_audio_base64: string;
    ref_filename: string;
    ref_mime_type: string;
    ref_text: string;
    speed: number;
    quality_mode: 'turbo' | 'balanced' | 'high';
  },
  signal: AbortSignal
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new Error('Đã hủy tiến trình.');
    try {
      const data = await apiFetch<{
        audio_base64: string;
        mime_type: string;
      }>('/api/tts/clone-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal,
      });
      return {
        bytes: base64ToUint8(data.audio_base64),
        mimeType: data.mime_type || 'audio/wav',
      };
    } catch (err) {
      if (signal.aborted) throw new Error('Đã hủy tiến trình.');
      lastErr = err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 900));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Lỗi kết nối GPU Clone trên Worker.');
}

async function runCloudSynthesis(payload: SynthesizePayload): Promise<JobRecord> {
  const isClone = Boolean(payload.cloned_voice_id);
  let effectiveEngine = payload.engine;
  if (isClone && !['zipvoice_gpu', 'f5_gpu', 'vieneu_gpu'].includes(effectiveEngine)) {
    effectiveEngine = 'zipvoice_gpu';
  }
  if (!isClone && effectiveEngine !== 'edge') {
    effectiveEngine = 'edge';
  }

  let refAudioB64 = '';
  let refFilename = 'ref.wav';
  let refMime = 'audio/wav';
  let refText = '';
  let voiceLabel = payload.voice_id;

  if (isClone && payload.cloned_voice_id) {
    const row = await localVault.getVoiceRow(payload.cloned_voice_id);
    if (!row) {
      throw new Error('Không tìm thấy giọng Clone trong trình duyệt. Hãy tạo lại trong Kho giọng Clone.');
    }
    refAudioB64 = await blobToBase64(row.audioBlob);
    refFilename = row.profile.audio_filename || 'ref.wav';
    refMime = row.audioBlob.type || 'audio/wav';
    refText = row.profile.ref_text || '';
    voiceLabel = row.profile.name;
  }

  const maxChars =
    effectiveEngine === 'edge'
      ? 1000
      : effectiveEngine === 'zipvoice_gpu'
        ? 260
        : effectiveEngine === 'f5_gpu'
          ? 300
          : 420;

  const textChunks = smartChunkText(payload.text, maxChars);
  if (textChunks.length === 0) {
    throw new Error('Văn bản trống.');
  }

  const jobId = makeJobId('vf');
  const trimmed = payload.text.trim();
  const chunksState: ChunkProgress[] = textChunks.map((t, idx) => ({
    index: idx,
    text_preview: t.length > 72 ? `${t.slice(0, 72)}…` : t,
    char_count: t.length,
    status: 'queued',
    duration_sec: 0,
  }));

  const record: JobRecord = {
    job_id: jobId,
    title: payload.title?.trim() || trimmed.slice(0, 48) || 'Bản thu mới',
    mode: 'single',
    status: 'running',
    progress: 2,
    current_chunk: 0,
    total_chunks: textChunks.length,
    chunks: chunksState,
    engine: effectiveEngine,
    voice_name: voiceLabel,
    cloned_voice_id: payload.cloned_voice_id || null,
    char_count: trimmed.length,
    word_count: trimmed ? trimmed.split(/\s+/).length : 0,
    duration_sec: 0,
    output_format: isClone ? 'wav' : payload.output_format,
    audio_url: null,
    wav_url: null,
    subtitle_srt_url: null,
    subtitle_vtt_url: null,
    waveform_peaks: [],
    text_preview: trimmed.slice(0, 160),
    favorite: false,
    error: null,
    created_at: new Date().toISOString(),
  };

  const controller = new AbortController();
  const active: ActiveCloudJob = { record, controller, listeners: new Set() };
  cloudJobs.set(jobId, active);

  // Run async background pipeline inside browser
  void (async () => {
    try {
      const results: Array<DecodedChunkAudio | null> = new Array(textChunks.length).fill(null);
      let completedCount = 0;

      const processChunk = async (idx: number) => {
        if (controller.signal.aborted) return;
        record.chunks[idx].status = 'processing';
        emitCloudJob(jobId);

        if (effectiveEngine === 'edge') {
          const out = await fetchEdgeChunkWithRetry(
            {
              text: textChunks[idx],
              voice_id: payload.voice_id || 'vi-VN-HoaiMyNeural',
              speed: payload.speed,
              pitch: payload.pitch,
              volume: payload.volume,
            },
            controller.signal
          );
          results[idx] = {
            bytes: out.bytes,
            mimeType: 'audio/mpeg',
            text: textChunks[idx],
            durationSec: out.durationSec,
            boundaries: out.boundaries,
            pauseAfterMs: payload.pause_ms,
          };
          record.chunks[idx].duration_sec = Number(out.durationSec.toFixed(1));
        } else {
          const out = await fetchCloneChunkWithRetry(
            {
              engine: effectiveEngine,
              text: textChunks[idx],
              ref_audio_base64: refAudioB64,
              ref_filename: refFilename,
              ref_mime_type: refMime,
              ref_text: refText,
              speed: payload.speed,
              quality_mode: payload.quality_mode || 'turbo',
            },
            controller.signal
          );
          results[idx] = {
            bytes: out.bytes,
            mimeType: out.mimeType,
            text: textChunks[idx],
            durationSec: Math.max(1, textChunks[idx].length / 15),
            pauseAfterMs: payload.pause_ms,
          };
          record.chunks[idx].duration_sec = Number(results[idx]!.durationSec.toFixed(1));
        }

        record.chunks[idx].status = 'done';
        completedCount++;
        record.current_chunk = completedCount;
        record.progress = Math.min(88, Math.round((completedCount / textChunks.length) * 86) + 2);
        emitCloudJob(jobId);
      };

      const concurrency = effectiveEngine === 'edge' ? 4 : 1;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrency, textChunks.length) }, async () => {
        while (cursor < textChunks.length && !controller.signal.aborted) {
          const idx = cursor++;
          await processChunk(idx);
        }
      });
      await Promise.all(workers);

      if (controller.signal.aborted) {
        record.status = 'cancelled';
        emitCloudJob(jobId);
        return;
      }

      record.status = 'stitching';
      record.progress = 92;
      emitCloudJob(jobId);

      const ordered = results.filter((r): r is DecodedChunkAudio => r !== null);
      const stitched = await stitchAudioChunks(ordered, {
        outputFormat: payload.output_format,
        normalizeAudio: payload.normalize_audio,
        generateSubtitles: payload.generate_subtitles,
      });

      record.status = 'completed';
      record.progress = 100;
      record.duration_sec = stitched.durationSec;
      record.output_format = stitched.actualFormat;
      record.waveform_peaks = stitched.waveformPeaks;

      const saved = await localVault.saveJob(record, {
        audioBlob: stitched.audioBlob,
        srtText: stitched.srtText,
        vttText: stitched.vttText,
      });

      Object.assign(record, saved);
      emitCloudJob(jobId);
    } catch (err) {
      if (controller.signal.aborted) {
        record.status = 'cancelled';
      } else {
        record.status = 'error';
        record.error = err instanceof Error ? err.message : 'Lỗi tổng hợp âm thanh.';
      }
      emitCloudJob(jobId);
    }
  })();

  return { ...record, chunks: record.chunks.map((c) => ({ ...c })) };
}

async function runCloudDialogue(payload: DialoguePayload): Promise<JobRecord> {
  const validLines = payload.lines.filter((l) => l.text.trim().length > 0);
  if (validLines.length === 0) {
    throw new Error('Không có lời thoại hợp lệ.');
  }

  const jobId = makeJobId('dlg');
  const fullText = validLines.map((l) => `${l.speaker}: ${l.text.trim()}`).join('\n');
  const chunksState: ChunkProgress[] = validLines.map((ln, idx) => ({
    index: idx,
    text_preview: `${ln.speaker}: ${ln.text.trim().slice(0, 60)}`,
    char_count: ln.text.trim().length,
    status: 'queued',
    duration_sec: 0,
    speaker: ln.speaker,
  }));

  const record: JobRecord = {
    job_id: jobId,
    title: payload.title.trim() || 'Hội thoại Podcast',
    mode: 'dialogue',
    status: 'running',
    progress: 2,
    current_chunk: 0,
    total_chunks: validLines.length,
    chunks: chunksState,
    engine: 'dialogue',
    voice_name: `${validLines.length} lượt thoại`,
    cloned_voice_id: null,
    char_count: fullText.length,
    word_count: fullText.split(/\s+/).length,
    duration_sec: 0,
    output_format: payload.output_format,
    audio_url: null,
    wav_url: null,
    subtitle_srt_url: null,
    subtitle_vtt_url: null,
    waveform_peaks: [],
    text_preview: fullText.slice(0, 160),
    favorite: false,
    error: null,
    created_at: new Date().toISOString(),
  };

  const controller = new AbortController();
  const active: ActiveCloudJob = { record, controller, listeners: new Set() };
  cloudJobs.set(jobId, active);

  void (async () => {
    try {
      const voiceCache = new Map<string, { b64: string; filename: string; mime: string; refText: string }>();
      const decodedChunks: DecodedChunkAudio[] = [];

      for (let i = 0; i < validLines.length; i++) {
        if (controller.signal.aborted) break;
        const ln = validLines[i];
        record.chunks[i].status = 'processing';
        emitCloudJob(jobId);

        if (ln.cloned_voice_id) {
          let cached = voiceCache.get(ln.cloned_voice_id);
          if (!cached) {
            const row = await localVault.getVoiceRow(ln.cloned_voice_id);
            if (!row) throw new Error(`Không tìm thấy giọng Clone cho nhân vật "${ln.speaker}".`);
            cached = {
              b64: await blobToBase64(row.audioBlob),
              filename: row.profile.audio_filename || 'ref.wav',
              mime: row.audioBlob.type || 'audio/wav',
              refText: row.profile.ref_text || '',
            };
            voiceCache.set(ln.cloned_voice_id, cached);
          }

          const cloneEngine = ['zipvoice_gpu', 'f5_gpu', 'vieneu_gpu'].includes(ln.engine)
            ? ln.engine
            : 'zipvoice_gpu';
          const out = await fetchCloneChunkWithRetry(
            {
              engine: cloneEngine,
              text: ln.text.trim(),
              ref_audio_base64: cached.b64,
              ref_filename: cached.filename,
              ref_mime_type: cached.mime,
              ref_text: cached.refText,
              speed: ln.speed,
              quality_mode: 'turbo',
            },
            controller.signal
          );
          decodedChunks.push({
            bytes: out.bytes,
            mimeType: out.mimeType,
            text: ln.text.trim(),
            speaker: ln.speaker,
            durationSec: Math.max(1, ln.text.trim().length / 15),
            pauseAfterMs: ln.pause_after_ms,
          });
        } else {
          const out = await fetchEdgeChunkWithRetry(
            {
              text: ln.text.trim(),
              voice_id: ln.voice_id || 'vi-VN-HoaiMyNeural',
              speed: ln.speed,
              pitch: ln.pitch,
              volume: 0,
            },
            controller.signal
          );
          decodedChunks.push({
            bytes: out.bytes,
            mimeType: 'audio/mpeg',
            text: ln.text.trim(),
            speaker: ln.speaker,
            durationSec: out.durationSec,
            boundaries: out.boundaries,
            pauseAfterMs: ln.pause_after_ms,
          });
        }

        record.chunks[i].status = 'done';
        record.chunks[i].duration_sec = Number(decodedChunks[decodedChunks.length - 1].durationSec.toFixed(1));
        record.current_chunk = i + 1;
        record.progress = Math.min(88, Math.round(((i + 1) / validLines.length) * 86) + 2);
        emitCloudJob(jobId);
      }

      if (controller.signal.aborted) {
        record.status = 'cancelled';
        emitCloudJob(jobId);
        return;
      }

      record.status = 'stitching';
      record.progress = 92;
      emitCloudJob(jobId);

      const stitched = await stitchAudioChunks(decodedChunks, {
        outputFormat: payload.output_format,
        normalizeAudio: payload.normalize_audio,
        generateSubtitles: payload.generate_subtitles,
      });

      record.status = 'completed';
      record.progress = 100;
      record.duration_sec = stitched.durationSec;
      record.output_format = stitched.actualFormat;
      record.waveform_peaks = stitched.waveformPeaks;

      const saved = await localVault.saveJob(record, {
        audioBlob: stitched.audioBlob,
        srtText: stitched.srtText,
        vttText: stitched.vttText,
      });

      Object.assign(record, saved);
      emitCloudJob(jobId);
    } catch (err) {
      if (controller.signal.aborted) {
        record.status = 'cancelled';
      } else {
        record.status = 'error';
        record.error = err instanceof Error ? err.message : 'Lỗi dựng hội thoại.';
      }
      emitCloudJob(jobId);
    }
  })();

  return { ...record, chunks: record.chunks.map((c) => ({ ...c })) };
}

// ---------------- Unified Dual-Mode API Export ----------------

export const api = {
  getRuntime: detectRuntime,

  getEngines: async () => {
    const res = await apiFetch<{ engines: EngineStatus[]; ffmpeg_ready: boolean; runtime?: string }>(
      '/api/engines'
    );
    if (res.runtime === 'cloudflare-hono') {
      cachedRuntime = 'cloudflare-hono';
    }
    return res;
  },

  getSettings: async () => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      const localTok = getLocalHfToken();
      if (localTok) {
        return { has_hf_token: true, hf_token_masked: maskToken(localTok) };
      }
      return apiFetch<{ has_hf_token: boolean; hf_token_masked: string }>('/api/settings');
    }
    return apiFetch<{ has_hf_token: boolean; hf_token_masked: string }>('/api/settings');
  },

  saveSettings: async (hfToken: string) => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      setLocalHfToken(hfToken);
      const clean = hfToken.trim();
      return {
        has_hf_token: Boolean(clean),
        hf_token_masked: maskToken(clean),
      };
    }
    return apiFetch<{ has_hf_token: boolean; hf_token_masked: string }>('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hf_token: hfToken }),
    });
  },

  prepareEngine: async (engineId: string) => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      return { status: 'ready', message: 'Mô hình đám mây trên Cloudflare Hono đã sẵn sàng.' };
    }
    return apiFetch<{ status: string; message?: string }>(`/api/engines/${engineId}/prepare`, {
      method: 'POST',
    });
  },

  getStockVoices: async (engine: string) => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono' && engine !== 'edge') {
      return { voices: [] as StockVoiceInfo[] };
    }
    return apiFetch<{ voices: StockVoiceInfo[] }>(
      `/api/voices/stock?engine=${encodeURIComponent(engine)}`
    );
  },

  getClonedVoices: async () => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      const voices = await localVault.listVoices();
      return { voices };
    }
    return apiFetch<{ voices: ClonedVoiceProfile[] }>('/api/voices/cloned');
  },

  createClonedVoice: async (formData: FormData) => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      const file = formData.get('file');
      if (!file || !(file instanceof File)) {
        throw new Error('Không tìm thấy tệp âm thanh mẫu.');
      }
      const denoise = String(formData.get('denoise') || 'false') === 'true';
      const analyzed = await preprocessReferenceAudio(file, denoise);

      let refText = String(formData.get('ref_text') || '').trim();
      if (!refText) {
        try {
          const fd = new FormData();
          fd.append('file', new File([analyzed.wavBlob], 'sample.wav', { type: 'audio/wav' }));
          const tr = await apiFetch<{ text?: string }>('/api/transcribe', {
            method: 'POST',
            body: fd,
          });
          if (tr.text) refText = tr.text;
        } catch {
          // Optional server Whisper; ignore if unavailable
        }
      }

      const id = makeJobId('voice');
      const rawTags = String(formData.get('tags') || '');
      const tags = rawTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const profile: ClonedVoiceProfile = {
        id,
        name: String(formData.get('name') || 'Giọng Clone mới').trim(),
        language: String(formData.get('language') || 'vi'),
        gender: String(formData.get('gender') || 'neutral'),
        description: String(formData.get('description') || ''),
        tags,
        avatar_gradient: 'from-slate-800 to-slate-600',
        audio_filename: `${id}.wav`,
        audio_url: '',
        duration_sec: analyzed.durationSec,
        quality_score: analyzed.qualityScore,
        quality_note: analyzed.qualityNote,
        ref_text: refText,
        waveform_peaks: analyzed.waveformPeaks,
        pitch_hz: analyzed.pitchHz,
        created_at: new Date().toISOString(),
      };

      return localVault.saveVoice(profile, analyzed.wavBlob);
    }

    return apiFetch<ClonedVoiceProfile>('/api/voices/cloned', {
      method: 'POST',
      body: formData,
    });
  },

  deleteClonedVoice: async (voiceId: string) => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      await localVault.deleteVoice(voiceId);
      return { deleted: true };
    }
    return apiFetch<{ deleted: boolean }>(`/api/voices/cloned/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
    });
  },

  startSynthesis: async (payload: SynthesizePayload) => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      return runCloudSynthesis(payload);
    }
    return apiFetch<JobRecord>('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  startDialogue: async (payload: DialoguePayload) => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      return runCloudDialogue(payload);
    }
    return apiFetch<JobRecord>('/api/tts/dialogue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  getJob: async (jobId: string) => {
    const active = cloudJobs.get(jobId);
    if (active) return { ...active.record };
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      const saved = await localVault.getJob(jobId);
      if (saved) return saved;
      throw new Error('Không tìm thấy tiến trình.');
    }
    return apiFetch<JobRecord>(`/api/jobs/${encodeURIComponent(jobId)}`);
  },

  cancelJob: async (jobId: string) => {
    const active = cloudJobs.get(jobId);
    if (active) {
      active.controller.abort();
      active.record.status = 'cancelled';
      emitCloudJob(jobId);
      return { cancelled: true };
    }
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      return { cancelled: true };
    }
    return apiFetch<{ cancelled: boolean }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
  },

  getHistory: async () => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      const jobs = await localVault.listJobs();
      return { jobs };
    }
    return apiFetch<{ jobs: JobRecord[] }>('/api/history');
  },

  toggleFavorite: async (jobId: string) => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      return localVault.toggleFavorite(jobId);
    }
    return apiFetch<JobRecord>(`/api/history/${encodeURIComponent(jobId)}/favorite`, {
      method: 'POST',
    });
  },

  deleteHistoryJob: async (jobId: string) => {
    const runtime = await detectRuntime();
    if (runtime === 'cloudflare-hono') {
      await localVault.deleteJob(jobId);
      return { deleted: true };
    }
    return apiFetch<{ deleted: boolean }>(`/api/history/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
    });
  },

  extractTextFromFile: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiFetch<{ filename: string; text: string; char_count: number }>('/api/text/extract', {
      method: 'POST',
      body: fd,
    });
  },

  subscribeJobEvents: (
    jobId: string,
    onUpdate: (job: JobRecord) => void,
    onDone?: (job: JobRecord) => void,
    onError?: (err: string) => void
  ): (() => void) => {
    // Cloud Hono in-browser job event bus
    const active = cloudJobs.get(jobId);
    if (active) {
      let finished = false;
      const listener = (job: JobRecord) => {
        onUpdate(job);
        if (
          !finished &&
          (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled')
        ) {
          finished = true;
          active.listeners.delete(listener);
          if (job.status === 'error') {
            onError?.(job.error || 'Synthesis failed');
          } else {
            onDone?.(job);
          }
        }
      };
      active.listeners.add(listener);
      // Deliver current state immediately
      listener({ ...active.record, chunks: active.record.chunks.map((c) => ({ ...c })) });
      return () => {
        active.listeners.delete(listener);
      };
    }

    // Local Python FastAPI SSE stream
    const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    let closed = false;

    es.onmessage = (ev) => {
      try {
        const job = JSON.parse(ev.data) as JobRecord;
        onUpdate(job);
        if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
          if (!closed) {
            closed = true;
            es.close();
          }
          if (job.status === 'error') {
            onError?.(job.error || 'Synthesis failed');
          } else {
            onDone?.(job);
          }
        }
      } catch {
        // ignore heartbeat parse
      }
    };

    es.onerror = () => {
      if (!closed) {
        closed = true;
        es.close();
        api
          .getJob(jobId)
          .then((j) => {
            onUpdate(j);
            if (j.status === 'completed' || j.status === 'cancelled') onDone?.(j);
            else if (j.status === 'error') onError?.(j.error || 'Connection error');
          })
          .catch(() => onError?.('Mất kết nối stream tiến độ'));
      }
    };

    return () => {
      closed = true;
      es.close();
    };
  },
};
