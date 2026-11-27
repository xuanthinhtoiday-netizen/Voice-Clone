import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fetchEdgeVoices, synthesizeEdgeChunk } from './edgeTts';
import { synthesizeF5VietnameseChunk } from './gradioClone';

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
        id: 'f5_gpu',
        name: 'F5-TTS Việt 6000h (GPU Cloud)',
        source_repo: 'SWivid/F5-TTS · hynt/F5-TTS-Vietnamese-ViVoice',
        ready: true,
        supports_cloning: true,
        supports_blending: false,
        supports_subtitles: true,
        max_chunk_chars: 135,
        badge: hasToken ? '6000h Việt · A10G GPU' : '6000h Việt · Nên thêm HF Token',
        description:
          'Bộ máy nhân bản giọng tiếng Việt Flow-Matching 6.000 giờ chuyên sâu: tự động căn mẫu giọng 5–9 giây, chuẩn hóa chữ số/từ tiếng Anh, chia đoạn ngắn chống nuốt chữ và giữ trọn âm sắc gốc.',
      },
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
      text: string;
      ref_audio_base64?: string;
      ref_filename?: string;
      ref_mime_type?: string;
      uploaded_ref_path?: string;
      speed?: number;
      normalize_vietnamese?: boolean;
    };

    if (!body.text?.trim()) {
      return c.json({ detail: 'Văn bản trống.' }, 400);
    }
    if (!body.ref_audio_base64 && !body.uploaded_ref_path) {
      return c.json({ detail: 'Thiếu dữ liệu giọng mẫu.' }, 400);
    }

    const hfToken = c.req.header('x-hf-token')?.trim() || c.env.HF_TOKEN;
    const refBytes = body.ref_audio_base64 ? base64ToUint8(body.ref_audio_base64) : undefined;

    const out = await synthesizeF5VietnameseChunk({
      text: body.text,
      refAudioBytes: refBytes,
      refFilename: body.ref_filename || 'ref.wav',
      refMimeType: body.ref_mime_type || 'audio/wav',
      uploadedRefPath: body.uploaded_ref_path,
      speed: body.speed ?? 1.0,
      normalizeVietnamese: body.normalize_vietnamese !== false,
      hfToken,
    });

    return c.json({
      audio_base64: uint8ToBase64(out.audioBytes),
      mime_type: out.mimeType,
      uploaded_ref_path: out.uploadedRefPath,
      normalized_text: out.normalizedText,
    });
  } catch (err) {
    return c.json(
      { detail: err instanceof Error ? err.message : 'Lỗi nhân bản giọng nói trên F5-TTS Việt GPU' },
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
