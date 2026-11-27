/**
 * Dedicated pure-fetch Gradio HTTP + SSE client for Cloudflare Workers (Hono.js),
 * specialized for hynt/F5-TTS-Vietnamese-100h (ViVoice 6,000h DiT model on NVIDIA GPU).
 */

import { normalizeVietnameseForF5 } from './f5TextNorm';

export type CloudCloneEngine = 'f5_gpu';

const F5_SPACE = {
  id: 'hynt/F5-TTS-Vietnamese-100h',
  baseUrl: 'https://hynt-f5-tts-vietnamese-100h.hf.space',
  apiName: 'infer_tts',
};

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

async function callGradioEndpoint(
  baseUrl: string,
  apiName: string,
  data: unknown[],
  hfToken?: string
): Promise<unknown[]> {
  const postRes = await fetch(`${baseUrl}/gradio_api/call/${apiName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(hfToken),
    },
    body: JSON.stringify({ data }),
  });

  if (!postRes.ok) {
    const errText = await postRes.text().catch(() => '');
    throw new Error(`F5-TTS call error (${postRes.status}): ${errText.slice(0, 200)}`);
  }

  const { event_id: eventId } = (await postRes.json()) as { event_id?: string };
  if (!eventId) {
    throw new Error('F5-TTS GPU Space không trả về event_id.');
  }

  const sseRes = await fetch(`${baseUrl}/gradio_api/call/${apiName}/${eventId}`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      ...authHeaders(hfToken),
    },
  });

  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`Không nhận được kết quả từ F5-TTS GPU (${sseRes.status}).`);
  }

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (currentEvent === 'error') {
          let msg = payload;
          try {
            const parsed = JSON.parse(payload);
            msg = parsed?.message || parsed?.title || payload;
          } catch {
            // keep raw
          }
          if (msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('zerogpu')) {
            throw new Error(
              'F5-TTS GPU miễn phí tạm hết hạn mức ZeroGPU. Vào mục "Mô hình AI" dán Hugging Face Token miễn phí (huggingface.co/settings/tokens) để mở khóa hạn mức cao hơn.'
            );
          }
          throw new Error(`F5-TTS GPU báo lỗi: ${msg}`);
        }
        if (currentEvent === 'complete') {
          try {
            const parsed = JSON.parse(payload);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            throw new Error('Không giải mã được dữ liệu trả về từ F5-TTS GPU.');
          }
        }
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
  hfToken?: string;
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

  const invokeWithPath = async (pathOnSpace: string) => {
    const filePayload = {
      path: pathOnSpace,
      meta: { _type: 'gradio.FileData' },
    };
    const result = await callGradioEndpoint(
      F5_SPACE.baseUrl,
      F5_SPACE.apiName,
      [filePayload, preparedText, clampedSpeed],
      params.hfToken
    );
    const audioUrl = extractAudioUrl(F5_SPACE.baseUrl, result[0]);
    const audioRes = await fetch(audioUrl, { headers: authHeaders(params.hfToken) });
    if (!audioRes.ok) {
      throw new Error(`Không tải được âm thanh kết quả từ F5-TTS GPU (${audioRes.status}).`);
    }
    const audioBytes = new Uint8Array(await audioRes.arrayBuffer());
    const mimeType = audioRes.headers.get('content-type') || 'audio/wav';
    return { audioBytes, mimeType, uploadedRefPath: pathOnSpace, normalizedText: preparedText };
  };

  // Reuse already-uploaded reference audio path on Space if provided (much faster for multi-chunk scripts)
  if (params.uploadedRefPath) {
    try {
      return await invokeWithPath(params.uploadedRefPath);
    } catch (err) {
      // If cached path expired on Space and we have bytes, re-upload seamlessly
      if (!params.refAudioBytes) throw err;
    }
  }

  if (!params.refAudioBytes || params.refAudioBytes.length === 0) {
    throw new Error('Thiếu dữ liệu tệp giọng mẫu để nhân bản.');
  }

  const uploadedPath = await uploadToGradio(
    F5_SPACE.baseUrl,
    params.refAudioBytes,
    params.refFilename || 'ref.wav',
    params.refMimeType || 'audio/wav',
    params.hfToken
  );

  return invokeWithPath(uploadedPath);
}
