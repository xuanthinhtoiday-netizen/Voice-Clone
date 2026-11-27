import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fetchEdgeVoices, synthesizeEdgeChunk } from './edgeTts';
import { synthesizeCloudCloneChunk, type CloudCloneEngine } from './gradioClone';

export interface Env {
  ASSETS: Fetcher;
  HF_TOKEN?: string;
  AI?: {
    run: (model: string, inputs: Record<string, unknown>) => Promise<{ text?: string }>;
  };
}

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    runtime: 'cloudflare-hono',
    ffmpeg: false,
    has_server_hf_token: Boolean(c.env.HF_TOKEN),
    has_workers_ai: Boolean(c.env.AI),
  });
});

app.get('/api/engines', (c) => {
  const headerToken = c.req.header('x-hf-token')?.trim();
  const hasToken = Boolean(headerToken || c.env.HF_TOKEN);

  return c.json({
    runtime: 'cloudflare-hono',
    ffmpeg_ready: true,
    engines: [
      {
        id: 'edge',
        name: 'Edge Neural Cloud (Hono Worker)',
        source_repo: 'rany2/edge-tts · Cloudflare Workers',
        ready: true,
        supports_cloning: false,
        supports_blending: false,
        supports_subtitles: true,
        max_chunk_chars: 1000,
        badge: 'Siêu tốc · 300+ giọng',
        description:
          'Chạy trực tiếp trên Cloudflare Workers qua WebSocket tới Microsoft Neural Voices. Tốc độ cực nhanh, không giới hạn ký tự và xuất phụ đề SRT từng chữ.',
      },
      {
        id: 'zipvoice_gpu',
        name: 'ZipVoice Việt Nam (GPU Cloud)',
        source_repo: 'k2-fsa/ZipVoice · sleeper371/zipvoice_vi',
        ready: true,
        supports_cloning: true,
        supports_blending: false,
        supports_subtitles: true,
        max_chunk_chars: 260,
        badge: hasToken ? 'Giống 99% · A10G GPU' : 'Giống 99% · Nên thêm HF Token',
        description:
          'Clone giọng tiếng Việt Flow-Matching giữ trọn vùng miền Bắc/Trung/Nam qua NVIDIA A10G GPU Cloud. Chạy trực tiếp từ Hono.js trên Cloudflare.',
      },
      {
        id: 'f5_gpu',
        name: 'F5-TTS Việt Nam (GPU Cloud)',
        source_repo: 'SWivid/F5-TTS · hynt/F5-TTS-Vietnamese',
        ready: true,
        supports_cloning: true,
        supports_blending: false,
        supports_subtitles: true,
        max_chunk_chars: 300,
        badge: 'Flow-Matching · A10G GPU',
        description:
          'Mô hình F5-TTS tiếng Việt chạy trên NVIDIA A10G GPU Cloud, giữ tốt nhịp đọc và biểu cảm tự nhiên của giọng mẫu.',
      },
      {
        id: 'vieneu_gpu',
        name: 'VieNeu v3 Turbo 48kHz (GPU Cloud)',
        source_repo: 'pnnbao-ump/VieNeu-TTS-v3-Turbo',
        ready: true,
        supports_cloning: true,
        supports_blending: false,
        supports_subtitles: true,
        max_chunk_chars: 420,
        badge: '48 kHz Studio · A10G GPU',
        description:
          'Mô hình VieNeu-TTS v3 Turbo chất lượng 48 kHz chạy trên NVIDIA A10G GPU Cloud, không cần nhập lời thoại ref_text.',
      },
    ],
  });
});

app.get('/api/voices/stock', async (c) => {
  const voices = await fetchEdgeVoices();
  return c.json({ voices });
});

app.get('/api/settings', (c) => {
  const hasServerToken = Boolean(c.env.HF_TOKEN);
  return c.json({
    has_hf_token: hasServerToken,
    hf_token_masked: hasServerToken ? 'Configured via Wrangler Secret' : '',
  });
});

app.post('/api/text/extract', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return c.json({ detail: 'Không tìm thấy tệp tải lên.' }, 400);
  }
  const f = file as File;
  let text = await f.text();
  const name = f.name || 'document.txt';
  if (name.toLowerCase().endsWith('.srt') || name.toLowerCase().endsWith('.vtt')) {
    text = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l !== 'WEBVTT' && !/^\d+$/.test(l) && !l.includes('-->'))
      .map((l) => l.replace(/<[^>]+>/g, ''))
      .join('\n');
  }
  return c.json({ filename: name, text, char_count: text.length });
});

app.post('/api/transcribe', async (c) => {
  if (!c.env.AI) {
    return c.json({ text: '', supported: false });
  }
  try {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return c.json({ detail: 'Thiếu file âm thanh.' }, 400);
    }
    const bytes = new Uint8Array(await (file as File).arrayBuffer());
    const result = await c.env.AI.run('@cf/openai/whisper', {
      audio: [...bytes],
    });
    return c.json({ text: (result?.text || '').trim(), supported: true });
  } catch (err) {
    return c.json({
      text: '',
      supported: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post('/api/tts/edge-chunk', async (c) => {
  try {
    const body = (await c.req.json()) as {
      text: string;
      voice_id?: string;
      speed?: number;
      pitch?: number;
      volume?: number;
    };

    if (!body.text || !body.text.trim()) {
      return c.json({ detail: 'Văn bản trống.' }, 400);
    }

    const res = await synthesizeEdgeChunk({
      text: body.text,
      voiceId: body.voice_id || 'vi-VN-HoaiMyNeural',
      speed: body.speed ?? 1.0,
      pitch: body.pitch ?? 0,
      volume: body.volume ?? 0,
    });

    return c.json({
      audio_base64: uint8ToBase64(res.mp3Bytes),
      mime_type: 'audio/mpeg',
      duration_sec: res.durationSec,
      boundaries: res.boundaries,
    });
  } catch (err) {
    return c.json(
      { detail: err instanceof Error ? err.message : 'Lỗi tổng hợp Edge-TTS trên Worker' },
      500
    );
  }
});

app.post('/api/tts/clone-chunk', async (c) => {
  try {
    const body = (await c.req.json()) as {
      engine?: CloudCloneEngine;
      text: string;
      ref_audio_base64: string;
      ref_filename?: string;
      ref_mime_type?: string;
      ref_text?: string;
      speed?: number;
      quality_mode?: 'turbo' | 'balanced' | 'high';
    };

    if (!body.text?.trim()) {
      return c.json({ detail: 'Văn bản trống.' }, 400);
    }
    if (!body.ref_audio_base64) {
      return c.json({ detail: 'Thiếu dữ liệu giọng mẫu.' }, 400);
    }

    const hfToken = c.req.header('x-hf-token')?.trim() || c.env.HF_TOKEN;
    const refBytes = base64ToUint8(body.ref_audio_base64);

    const out = await synthesizeCloudCloneChunk({
      engine: body.engine || 'zipvoice_gpu',
      text: body.text,
      refAudioBytes: refBytes,
      refFilename: body.ref_filename || 'ref.wav',
      refMimeType: body.ref_mime_type || 'audio/wav',
      refText: body.ref_text,
      speed: body.speed ?? 1.0,
      qualityMode: body.quality_mode || 'turbo',
      hfToken,
    });

    return c.json({
      audio_base64: uint8ToBase64(out.audioBytes),
      mime_type: out.mimeType,
    });
  } catch (err) {
    return c.json(
      { detail: err instanceof Error ? err.message : 'Lỗi nhân bản giọng nói trên GPU Cloud' },
      500
    );
  }
});

// Serve React SPA static assets for all non-API routes
app.all('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('VoxForge Hono Worker is running. Build frontend/dist to serve UI.', 200);
});

export default app;
