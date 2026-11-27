import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fetchEdgeVoices, synthesizeEdgeChunk } from './edgeTts';
import {
  parseHfTokens,
  synthesizeF5VietnameseChunk,
  synthesizeViaCustomF5Server,
  testCustomF5Server,
} from './gradioClone';

export interface Env {
  ASSETS: Fetcher;
  HF_TOKEN?: string;
  F5_SERVER_URL?: string;
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
    has_server_f5_url: Boolean(c.env.F5_SERVER_URL),
    has_workers_ai: Boolean(c.env.AI),
  });
});

app.get('/api/engines', (c) => {
  const headerToken = c.req.header('x-hf-token')?.trim();
  const hasToken = Boolean(headerToken || c.env.HF_TOKEN);
  const customF5Url = c.req.header('x-f5-server-url')?.trim() || c.env.F5_SERVER_URL?.trim();
  const hasCustomGpu = Boolean(customF5Url);

  return c.json({
    runtime: 'cloudflare-hono',
    ffmpeg_ready: true,
    has_custom_f5_gpu: hasCustomGpu,
    engines: [
      {
        id: 'f5_gpu',
        name: hasCustomGpu
          ? 'F5-TTS Việt 6000h (Colab GPU Riêng)'
          : 'F5-TTS Việt 6000h (GPU Cloud)',
        source_repo: hasCustomGpu
          ? 'Google Colab T4 · Cloudflare Tunnel'
          : 'SWivid/F5-TTS · hynt/F5-TTS-Vietnamese-ViVoice',
        ready: true,
        supports_cloning: true,
        supports_blending: false,
        supports_subtitles: true,
        max_chunk_chars: 2400,
        badge: hasCustomGpu
          ? 'GPU Riêng · Không giới hạn'
          : hasToken
            ? '6000h Việt · HF Token'
            : 'Nên gắn Colab GPU miễn phí',
        description: hasCustomGpu
          ? 'Đang kết nối trực tiếp tới GPU Server F5-TTS Việt 6000h riêng (Google Colab / Kaggle). Không giới hạn ký tự, không bị giới hạn ZeroGPU, chỉ nhận diện giọng mẫu 1 lần cho cả cuốn truyện.'
          : 'Bộ máy nhân bản giọng tiếng Việt Flow-Matching 6.000 giờ chuyên sâu: gộp tới 2.400 ký tự/lượt, tự ngắt câu chống nuốt chữ và chuẩn hóa chữ số/từ tiếng Anh. Gắn thêm Google Colab T4 miễn phí bên dưới để đọc không giới hạn.',
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
  const hasServerF5Url = Boolean(c.env.F5_SERVER_URL);
  return c.json({
    has_hf_token: hasServerToken,
    hf_token_masked: hasServerToken ? 'Configured via Wrangler Secret' : '',
    has_f5_server_url: hasServerF5Url,
    f5_server_url: hasServerF5Url ? 'Configured via Worker Env' : '',
  });
});

app.post('/api/f5-server/test', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string };
    const targetUrl =
      body.url?.trim() || c.req.header('x-f5-server-url')?.trim() || c.env.F5_SERVER_URL?.trim();
    if (!targetUrl) {
      return c.json({ ok: false, error: 'Chưa nhập đường link GPU Server.' }, 400);
    }
    const result = await testCustomF5Server(targetUrl);
    return c.json(result, result.ok ? 200 : 502);
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : 'Lỗi kiểm tra kết nối GPU.' },
      500
    );
  }
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
      ref_text?: string;
      ref_hash?: string;
      uploaded_ref_path?: string;
      speed?: number;
      nfe_step?: number;
      normalize_vietnamese?: boolean;
    };

    if (!body.text?.trim()) {
      return c.json({ detail: 'Văn bản trống.' }, 400);
    }
    if (!body.ref_audio_base64 && !body.uploaded_ref_path && !body.ref_hash) {
      return c.json({ detail: 'Thiếu dữ liệu giọng mẫu.' }, 400);
    }

    // Priority 1: Dedicated Google Colab / Kaggle / Self-hosted F5-TTS GPU Server (UNLIMITED!)
    const customF5Url = c.req.header('x-f5-server-url')?.trim() || c.env.F5_SERVER_URL?.trim();
    if (customF5Url) {
      const out = await synthesizeViaCustomF5Server({
        serverUrl: customF5Url,
        text: body.text,
        refAudioBase64: body.ref_audio_base64,
        refHash: body.ref_hash,
        refText: body.ref_text,
        speed: body.speed ?? 1.0,
        nfeStep: body.nfe_step ?? 32,
        normalizeVietnamese: body.normalize_vietnamese !== false,
      });

      return c.json({
        audio_base64: out.audioBase64,
        mime_type: out.mimeType,
        ref_hash: out.refHash,
        duration_sec: out.durationSec,
        gpu: out.gpu,
        normalized_text: out.normalizedText,
      });
    }

    // Priority 2: Public Hugging Face Space fallback with multi-token rotation
    const hfTokens = parseHfTokens(c.req.header('x-hf-token'), c.env.HF_TOKEN);
    const refBytes = body.ref_audio_base64 ? base64ToUint8(body.ref_audio_base64) : undefined;

    const out = await synthesizeF5VietnameseChunk({
      text: body.text,
      refAudioBytes: refBytes,
      refFilename: body.ref_filename || 'ref.wav',
      refMimeType: body.ref_mime_type || 'audio/wav',
      uploadedRefPath: body.uploaded_ref_path,
      speed: body.speed ?? 1.0,
      normalizeVietnamese: body.normalize_vietnamese !== false,
      hfTokens,
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
