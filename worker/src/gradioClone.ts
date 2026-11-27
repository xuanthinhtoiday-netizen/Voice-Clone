/**
 * Pure-fetch Gradio v5/v6 HTTP + SSE client for Cloudflare Workers (Hono.js).
 * Connects directly to NVIDIA A10G GPU Hugging Face Spaces for real Zero-Shot
 * Vietnamese & Multilingual Voice Cloning (ZipVoice-VI, F5-TTS-VN, VieNeu v3 Turbo).
 */

export type CloudCloneEngine = 'zipvoice_gpu' | 'f5_gpu' | 'vieneu_gpu';

interface SpaceSpec {
  id: string;
  baseUrl: string;
  apiName: string;
}

const SPACES: Record<CloudCloneEngine, SpaceSpec> = {
  zipvoice_gpu: {
    id: 'sleeper371/zipvoice_vi',
    baseUrl: 'https://sleeper371-zipvoice-vi.hf.space',
    apiName: 'synthesize',
  },
  f5_gpu: {
    id: 'hynt/F5-TTS-Vietnamese-100h',
    baseUrl: 'https://hynt-f5-tts-vietnamese-100h.hf.space',
    apiName: 'infer_tts',
  },
  vieneu_gpu: {
    id: 'pnnbao-ump/VieNeu-TTS-v3-Turbo',
    baseUrl: 'https://pnnbao-ump-vieneu-tts-v3-turbo.hf.space',
    apiName: 'synthesize',
  },
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
    throw new Error('Gradio Space không trả về đường dẫn tệp mẫu.');
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
    throw new Error(`Gradio call error (${postRes.status}): ${errText.slice(0, 200)}`);
  }

  const { event_id: eventId } = (await postRes.json()) as { event_id?: string };
  if (!eventId) {
    throw new Error('Gradio Space không trả về event_id.');
  }

  const sseRes = await fetch(`${baseUrl}/gradio_api/call/${apiName}/${eventId}`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      ...authHeaders(hfToken),
    },
  });

  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`Không nhận được kết quả SSE từ GPU Space (${sseRes.status}).`);
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
              'GPU Cloud miễn phí tạm hết hạn mức ZeroGPU. Hãy vào mục "Mô hình AI" dán Hugging Face Token miễn phí (huggingface.co/settings/tokens) để mở khóa hạn mức cao hơn.'
            );
          }
          throw new Error(`GPU Space báo lỗi: ${msg}`);
        }
        if (currentEvent === 'complete') {
          try {
            const parsed = JSON.parse(payload);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            throw new Error('Không giải mã được dữ liệu trả về từ GPU Space.');
          }
        }
      }
    }
  }

  throw new Error('GPU Space đóng kết nối trước khi hoàn tất tổng hợp.');
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
  throw new Error('Không tìm thấy URL tệp âm thanh từ GPU Space.');
}

export async function synthesizeCloudCloneChunk(params: {
  engine: CloudCloneEngine;
  text: string;
  refAudioBytes: Uint8Array;
  refFilename: string;
  refMimeType: string;
  refText?: string;
  speed?: number;
  qualityMode?: 'turbo' | 'balanced' | 'high';
  hfToken?: string;
}): Promise<{ audioBytes: Uint8Array; mimeType: string }> {
  const spec = SPACES[params.engine] || SPACES.zipvoice_gpu;
  const uploadedPath = await uploadToGradio(
    spec.baseUrl,
    params.refAudioBytes,
    params.refFilename,
    params.refMimeType,
    params.hfToken
  );

  const filePayload = {
    path: uploadedPath,
    meta: { _type: 'gradio.FileData' },
  };

  let callData: unknown[];
  if (params.engine === 'zipvoice_gpu') {
    const steps = params.qualityMode === 'high' ? 12 : params.qualityMode === 'balanced' ? 8 : 6;
    callData = [
      filePayload,
      (params.refText || 'xin chào đây là giọng nói mẫu của tôi.').trim(),
      params.text,
      params.speed ?? 1.0,
      steps,
      666,
    ];
  } else if (params.engine === 'f5_gpu') {
    callData = [filePayload, params.text, params.speed ?? 1.0];
  } else {
    // vieneu_gpu (pnnbao-ump/VieNeu-TTS-v3-Turbo)
    callData = [
      params.text,
      'Hải Đăng',
      filePayload,
      0.8,
      25,
      0.95,
      1.2,
      300,
      256,
    ];
  }

  const result = await callGradioEndpoint(spec.baseUrl, spec.apiName, callData, params.hfToken);
  const audioUrl = extractAudioUrl(spec.baseUrl, result[0]);

  const audioRes = await fetch(audioUrl, { headers: authHeaders(params.hfToken) });
  if (!audioRes.ok) {
    throw new Error(`Không tải được âm thanh kết quả từ GPU Space (${audioRes.status}).`);
  }
  const buf = new Uint8Array(await audioRes.arrayBuffer());
  const mimeType = audioRes.headers.get('content-type') || 'audio/wav';
  return { audioBytes: buf, mimeType };
}
