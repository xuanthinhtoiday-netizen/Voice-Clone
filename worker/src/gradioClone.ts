/**
 * Dedicated pure-fetch Gradio Queue (SSE) client for Cloudflare Workers (Hono.js),
 * specialized for hynt/F5-TTS-Vietnamese-100h (ViVoice 6,000h DiT model on NVIDIA GPU).
 *
 * Uses /gradio_api/queue/join + /gradio_api/queue/data so real Gradio error details
 * (such as ZeroGPU quota messages) are always preserved instead of "null", and supports
 * automatic rotation across multiple Hugging Face Read tokens.
 */

import { normalizeVietnameseForF5 } from './f5TextNorm';

export type CloudCloneEngine = 'f5_gpu';

const F5_SPACE = {
  id: 'hynt/F5-TTS-Vietnamese-100h',
  baseUrl: 'https://hynt-f5-tts-vietnamese-100h.hf.space',
  fnIndex: 0,
};

export function parseHfTokens(...rawSources: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of rawSources) {
    if (!src) continue;
    for (const part of src.split(/[\s,;]+/)) {
      const clean = part.trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
  }
  return out;
}

function authHeaders(hfToken?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hfToken && hfToken.trim()) {
    headers['Authorization'] = `Bearer ${hfToken.trim()}`;
  }
  return headers;
}

async function uploadToGradio(
  baseUrl: string,
  refAudioBytes: Uint8Array,
  filename: string,
  mimeType: string,
  hfToken?: string
): Promise<string> {
  const form = new FormData();
  const ab = refAudioBytes.buffer.slice(
    refAudioBytes.byteOffset,
    refAudioBytes.byteOffset + refAudioBytes.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([ab], { type: mimeType || 'audio/wav' });
  form.append('files', blob, filename || 'ref.wav');

  const res = await fetch(`${baseUrl}/gradio_api/upload`, {
    method: 'POST',
    headers: authHeaders(hfToken),
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Upload mẫu giọng thất bại (${res.status}): ${txt.slice(0, 160)}`);
  }
  const paths = (await res.json()) as string[];
  if (!Array.isArray(paths) || !paths[0]) {
    throw new Error('F5-TTS GPU Space không trả về đường dẫn tệp mẫu.');
  }
  return paths[0];
}

class ZeroGpuQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZeroGpuQuotaError';
  }
}

async function callGradioQueue(
  baseUrl: string,
  fnIndex: number,
  data: unknown[],
  hfToken?: string
): Promise<unknown[]> {
  const sessionHash = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

  const joinRes = await fetch(`${baseUrl}/gradio_api/queue/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(hfToken),
    },
    body: JSON.stringify({
      data,
      event_data: null,
      fn_index: fnIndex,
      trigger_id: 12,
      session_hash: sessionHash,
    }),
  });

  if (!joinRes.ok) {
    const errText = await joinRes.text().catch(() => '');
    throw new Error(`F5-TTS queue join error (${joinRes.status}): ${errText.slice(0, 200)}`);
  }

  const sseRes = await fetch(
    `${baseUrl}/gradio_api/queue/data?session_hash=${encodeURIComponent(sessionHash)}`,
    {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...authHeaders(hfToken),
      },
    }
  );

  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`Không nhận được luồng phản hồi từ F5-TTS GPU (${sseRes.status}).`);
  }

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;

      let msg: {
        msg?: string;
        success?: boolean;
        title?: string;
        output?: {
          data?: unknown[];
          error?: string;
          title?: string;
        };
      };
      try {
        msg = JSON.parse(payload);
      } catch {
        continue;
      }

      if (msg.msg === 'process_completed') {
        if (msg.success && Array.isArray(msg.output?.data)) {
          return msg.output.data;
        }
        const rawErr = msg.output?.error || msg.output?.title || msg.title || 'Lỗi xử lý trên GPU Space';
        const lower = rawErr.toLowerCase();
        if (lower.includes('quota') || lower.includes('zerogpu') || lower.includes('exceeded')) {
          throw new ZeroGpuQuotaError(
            'Hết hạn mức ZeroGPU miễn phí tạm thời. Vào mục "Mô hình AI" dán 1 hoặc nhiều Hugging Face Token (Read) miễn phí từ huggingface.co/settings/tokens để tiếp tục tạo giọng không gián đoạn.'
          );
        }
        throw new Error(`F5-TTS GPU báo lỗi: ${rawErr}`);
      }
    }
  }

  throw new Error('F5-TTS GPU đóng kết nối trước khi hoàn tất tổng hợp.');
}

function extractAudioUrl(baseUrl: string, item: unknown): string {
  if (typeof item === 'string') {
    if (item.startsWith('http://') || item.startsWith('https://')) return item;
    return `${baseUrl}/gradio_api/file=${item}`;
  }
  if (item && typeof item === 'object') {
    const obj = item as { url?: string; path?: string };
    if (obj.url) return obj.url;
    if (obj.path) return `${baseUrl}/gradio_api/file=${obj.path}`;
  }
  throw new Error('Không tìm thấy URL tệp âm thanh từ F5-TTS GPU.');
}

export async function synthesizeF5VietnameseChunk(params: {
  text: string;
  refAudioBytes?: Uint8Array;
  refFilename?: string;
  refMimeType?: string;
  uploadedRefPath?: string;
  speed?: number;
  normalizeVietnamese?: boolean;
  hfTokens?: string[];
}): Promise<{
  audioBytes: Uint8Array;
  mimeType: string;
  uploadedRefPath: string;
  normalizedText: string;
}> {
  const preparedText =
    params.normalizeVietnamese === false
      ? params.text.trim()
      : normalizeVietnameseForF5(params.text);

  if (!preparedText) {
    throw new Error('Đoạn văn bản sau chuẩn hóa bị trống.');
  }

  const clampedSpeed = Math.max(0.5, Math.min(1.8, Number((params.speed ?? 1.0).toFixed(2))));

  // Build token candidates: provided HF tokens first, or anonymous fallback if none configured
  const candidates: Array<string | undefined> =
    params.hfTokens && params.hfTokens.length > 0 ? params.hfTokens : [undefined];

  let lastError: unknown;
  let cachedPath = params.uploadedRefPath;

  for (let i = 0; i < candidates.length; i++) {
    const tok = candidates[i];
    try {
      if (!cachedPath) {
        if (!params.refAudioBytes || params.refAudioBytes.length === 0) {
          throw new Error('Thiếu dữ liệu tệp giọng mẫu để nhân bản.');
        }
        cachedPath = await uploadToGradio(
          F5_SPACE.baseUrl,
          params.refAudioBytes,
          params.refFilename || 'ref.wav',
          params.refMimeType || 'audio/wav',
          tok
        );
      }

      const filePayload = {
        path: cachedPath,
        orig_name: params.refFilename || 'ref.wav',
        meta: { _type: 'gradio.FileData' },
      };

      const result = await callGradioQueue(
        F5_SPACE.baseUrl,
        F5_SPACE.fnIndex,
        [filePayload, preparedText, clampedSpeed],
        tok
      );

      const audioUrl = extractAudioUrl(F5_SPACE.baseUrl, result[0]);
      const audioRes = await fetch(audioUrl, { headers: authHeaders(tok) });
      if (!audioRes.ok) {
        throw new Error(`Không tải được âm thanh kết quả từ F5-TTS GPU (${audioRes.status}).`);
      }
      const audioBytes = new Uint8Array(await audioRes.arrayBuffer());
      const mimeType = audioRes.headers.get('content-type') || 'audio/wav';
      return {
        audioBytes,
        mimeType,
        uploadedRefPath: cachedPath,
        normalizedText: preparedText,
      };
    } catch (err) {
      lastError = err;
      if (err instanceof ZeroGpuQuotaError) {
        // Rotate to next token seamlessly if available
        if (i < candidates.length - 1) {
          continue;
        }
        throw err;
      }
      // If a stale uploadedRefPath failed on first try and we have raw bytes, clear path and retry once
      if (cachedPath && params.uploadedRefPath && params.refAudioBytes) {
        cachedPath = undefined;
        params.uploadedRefPath = undefined;
        i--;
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Lỗi tổng hợp âm thanh trên F5-TTS Việt GPU.');
}

function normalizeServerBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    throw new Error('Link GPU Server không hợp lệ (cần bắt đầu bằng https:// hoặc http://).');
  }
  return trimmed;
}

export async function testCustomF5Server(rawUrl: string): Promise<{
  ok: boolean;
  gpu?: string;
  model?: string;
  cached_voices?: number;
  error?: string;
}> {
  try {
    const base = normalizeServerBaseUrl(rawUrl);
    const res = await fetch(`${base}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, error: `Server trả về HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      status?: string;
      gpu?: string;
      model?: string;
      cached_voices?: number;
    };
    if (data?.status !== 'ok') {
      return { ok: false, error: 'Phản hồi /health không hợp lệ.' };
    }
    return {
      ok: true,
      gpu: data.gpu || 'GPU',
      model: data.model || 'F5-TTS-Vietnamese-6000h',
      cached_voices: data.cached_voices ?? 0,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Không kết nối được tới Colab GPU Server: ${err.message}`
          : 'Không kết nối được tới Colab GPU Server.',
    };
  }
}

export async function synthesizeViaCustomF5Server(params: {
  serverUrl: string;
  text: string;
  refAudioBase64?: string;
  refHash?: string;
  refText?: string;
  speed?: number;
  nfeStep?: number;
  normalizeVietnamese?: boolean;
}): Promise<{
  audioBase64: string;
  mimeType: string;
  refHash?: string;
  durationSec?: number;
  gpu?: string;
  normalizedText: string;
}> {
  const base = normalizeServerBaseUrl(params.serverUrl);
  const preparedText =
    params.normalizeVietnamese === false
      ? params.text.trim()
      : normalizeVietnameseForF5(params.text);

  if (!preparedText) {
    throw new Error('Đoạn văn bản sau chuẩn hóa bị trống.');
  }

  const clampedSpeed = Math.max(0.5, Math.min(1.8, Number((params.speed ?? 1.0).toFixed(2))));

  const postOnce = async (useHashOnly: boolean) => {
    const payload: Record<string, unknown> = {
      text: preparedText,
      speed: clampedSpeed,
      nfe_step: params.nfeStep ?? 32,
      ref_text: params.refText || '',
    };
    if (useHashOnly && params.refHash) {
      payload.ref_hash = params.refHash;
    } else if (params.refAudioBase64) {
      payload.ref_audio_base64 = params.refAudioBase64;
      if (params.refHash) payload.ref_hash = params.refHash;
    }

    return fetch(`${base}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  let res = await postOnce(Boolean(params.refHash && !params.refAudioBase64));

  // If cached voice hash expired on Colab restart, automatically re-send audio bytes once
  if (res.status === 404 && params.refAudioBase64) {
    res = await postOnce(false);
  }

  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(
      `Colab GPU Server báo lỗi (${res.status}). Hãy kiểm tra tab Google Colab còn đang chạy không. ${errTxt.slice(0, 160)}`
    );
  }

  const data = (await res.json()) as {
    audio_base64?: string;
    mime_type?: string;
    ref_hash?: string;
    duration_sec?: number;
    gpu?: string;
  };
  if (!data.audio_base64) {
    throw new Error('Colab GPU Server không trả về dữ liệu âm thanh.');
  }

  return {
    audioBase64: data.audio_base64,
    mimeType: data.mime_type || 'audio/wav',
    refHash: data.ref_hash,
    durationSec: data.duration_sec,
    gpu: data.gpu,
    normalizedText: preparedText,
  };
}
