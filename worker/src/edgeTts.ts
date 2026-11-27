/**
 * Native Cloudflare Workers Microsoft Edge Neural TTS client (zero Node deps).
 * Uses Workers WebSocket upgrade via fetch() + exact Sec-MS-GEC v2 DRM token.
 */

import {
  CHROMIUM_MAJOR_VERSION,
  SEC_MS_GEC_VERSION,
  TRUSTED_CLIENT_TOKEN,
  generateConnectId,
  generateMuid,
  generateSecMsGecV2,
} from './edgeDrm';

export interface StockVoiceInfo {
  id: string;
  name: string;
  short_name: string;
  engine: string;
  language: string;
  locale: string;
  gender: string;
  style_tags: string[];
  recommended: boolean;
}

export interface WordBoundary {
  type: 'WordBoundary' | 'SentenceBoundary';
  start: number;
  end: number;
  text: string;
}

const BASE_HOST = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;

export const DEFAULT_EDGE_VOICES: StockVoiceInfo[] = [
  {
    id: 'vi-VN-HoaiMyNeural',
    name: 'Hoài My (vi-VN · Female)',
    short_name: 'Hoài My',
    engine: 'edge',
    language: 'Vietnamese',
    locale: 'vi-VN',
    gender: 'Female',
    style_tags: ['Tiếng Việt', 'Tự nhiên'],
    recommended: true,
  },
  {
    id: 'vi-VN-NamMinhNeural',
    name: 'Nam Minh (vi-VN · Male)',
    short_name: 'Nam Minh',
    engine: 'edge',
    language: 'Vietnamese',
    locale: 'vi-VN',
    gender: 'Male',
    style_tags: ['Tiếng Việt', 'Trầm ấm'],
    recommended: true,
  },
  {
    id: 'en-US-AndrewMultilingualNeural',
    name: 'Andrew Multi (en-US · Male)',
    short_name: 'Andrew Multi',
    engine: 'edge',
    language: 'Multilingual',
    locale: 'en-US',
    gender: 'Male',
    style_tags: ['Multilingual'],
    recommended: true,
  },
  {
    id: 'en-US-AvaMultilingualNeural',
    name: 'Ava Multi (en-US · Female)',
    short_name: 'Ava Multi',
    engine: 'edge',
    language: 'Multilingual',
    locale: 'en-US',
    gender: 'Female',
    style_tags: ['Multilingual'],
    recommended: true,
  },
];

export async function fetchEdgeVoices(): Promise<StockVoiceInfo[]> {
  try {
    const gec = generateSecMsGecV2();
    const url = `https://${BASE_HOST}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${generateMuid()};`,
      },
    });
    if (!res.ok) return DEFAULT_EDGE_VOICES;
    const raw = (await res.json()) as Array<{
      ShortName?: string;
      Locale?: string;
      Gender?: string;
      VoiceTag?: { VoicePersonalities?: string[] };
    }>;

    const priorityIds = new Set(DEFAULT_EDGE_VOICES.map((v) => v.id));
    const parsed: StockVoiceInfo[] = raw
      .filter((x) => Boolean(x.ShortName))
      .map((item) => {
        const id = item.ShortName!;
        const locale = item.Locale || '';
        const gender = item.Gender || 'Neutral';
        const cleanShort = id
          .split('-')
          .pop()!
          .replace('Neural', '')
          .replace('Multilingual', ' Multi');
        let language = locale;
        if (locale.startsWith('vi-')) language = 'Vietnamese';
        else if (locale.startsWith('en-')) language = 'English';
        else if (locale.startsWith('ja-')) language = 'Japanese';
        else if (locale.startsWith('ko-')) language = 'Korean';
        else if (locale.startsWith('zh-')) language = 'Chinese';
        else if (locale.startsWith('fr-')) language = 'French';
        else if (locale.startsWith('de-')) language = 'German';
        else if (locale.startsWith('es-')) language = 'Spanish';

        const tags: string[] = [];
        if (id.includes('Multilingual')) tags.push('Multilingual');
        if (locale === 'vi-VN') tags.push('Tiếng Việt');
        if (item.VoiceTag?.VoicePersonalities) {
          tags.push(...item.VoiceTag.VoicePersonalities.slice(0, 2));
        }

        return {
          id,
          name: `${cleanShort} (${locale} · ${gender})`,
          short_name: cleanShort,
          engine: 'edge',
          language,
          locale,
          gender,
          style_tags: tags.slice(0, 3),
          recommended: priorityIds.has(id) || locale === 'vi-VN',
        };
      });

    parsed.sort((a, b) => {
      const rank = (v: StockVoiceInfo) =>
        v.locale === 'vi-VN'
          ? 0
          : v.recommended
            ? 1
            : v.id.includes('Multilingual')
              ? 2
              : v.locale.startsWith('en-US')
                ? 3
                : 4;
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
    return parsed.length > 0 ? parsed : DEFAULT_EDGE_VOICES;
  } catch {
    return DEFAULT_EDGE_VOICES;
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatRate(speed: number): string {
  const pct = Math.round((speed - 1.0) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function formatPitch(pitch: number): string {
  const hz = Math.round(pitch * 2.5);
  return hz >= 0 ? `+${hz}Hz` : `${hz}Hz`;
}

function formatVolume(volume: number): string {
  return volume >= 0 ? `+${volume}%` : `${volume}%`;
}

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function synthesizeEdgeChunk(params: {
  text: string;
  voiceId: string;
  speed?: number;
  pitch?: number;
  volume?: number;
}): Promise<{ mp3Bytes: Uint8Array; boundaries: WordBoundary[]; durationSec: number }> {
  const { text, voiceId, speed = 1.0, pitch = 0, volume = 0 } = params;
  const cleanText = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim();
  if (!cleanText) {
    throw new Error('Đoạn văn bản trống.');
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await _synthesizeEdgeOnce(cleanText, voiceId, speed, pitch, volume);
      if (result.mp3Bytes.byteLength > 0) return result;
      lastErr = new Error('Edge-TTS trả về dữ liệu rỗng.');
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
  }

  throw new Error(`Edge-TTS lỗi sau 3 lần thử: ${lastErr?.message || 'unknown'}`);
}

async function _synthesizeEdgeOnce(
  text: string,
  voiceId: string,
  speed: number,
  pitch: number,
  volume: number
): Promise<{ mp3Bytes: Uint8Array; boundaries: WordBoundary[]; durationSec: number }> {
  const connId = generateConnectId();
  const gec = generateSecMsGecV2();
  const url = `https://${BASE_HOST}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;

  const resp = await fetch(url, {
    headers: {
      Upgrade: 'websocket',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: `muid=${generateMuid()};`,
    },
  });

  const ws = resp.webSocket;
  if (!ws) {
    throw new Error(`Edge WebSocket upgrade failed (HTTP ${resp.status})`);
  }
  ws.accept();

  const audioChunks: Uint8Array[] = [];
  const boundaries: WordBoundary[] = [];
  const reqId = generateConnectId();
  const dateStr = new Date().toUTCString();

  const configMsg =
    `X-Timestamp:${dateStr}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: 'false',
              wordBoundaryEnabled: 'true',
            },
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
          },
        },
      },
    });

  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${escapeXml(voiceId)}'>` +
    `<prosody pitch='${formatPitch(pitch)}' rate='${formatRate(speed)}' volume='${formatVolume(volume)}'>` +
    `${escapeXml(text)}` +
    `</prosody></voice></speak>`;

  const ssmlMsg =
    `X-RequestId:${reqId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${dateStr}Z\r\n` +
    `Path:ssml\r\n\r\n` +
    ssml;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close(1000, 'timeout');
        } catch {
          // ignore
        }
        reject(new Error('Edge-TTS WebSocket timeout'));
      }
    }, 35_000);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close(1000, 'done');
      } catch {
        // ignore
      }
      const mp3Bytes = concatUint8(audioChunks);
      // audio-24khz-48kbitrate-mono-mp3 is 48 kbps CBR = 6000 bytes/sec
      const durationSec = Number((mp3Bytes.byteLength / 6000).toFixed(2));
      resolve({ mp3Bytes, boundaries, durationSec });
    };

    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        const textData = ev.data;
        if (textData.includes('Path:turn.end')) {
          finish();
          return;
        }
        if (textData.includes('Path:audio.metadata')) {
          const splitIdx = textData.indexOf('\r\n\r\n');
          if (splitIdx !== -1) {
            try {
              const meta = JSON.parse(textData.slice(splitIdx + 4)) as {
                Metadata?: Array<{
                  Type?: string;
                  Data?: { Offset?: number; Duration?: number; text?: { Text?: string } };
                }>;
              };
              for (const item of meta.Metadata || []) {
                if (
                  (item.Type === 'WordBoundary' || item.Type === 'SentenceBoundary') &&
                  item.Data
                ) {
                  const start = (item.Data.Offset || 0) / 10_000_000;
                  const dur = (item.Data.Duration || 0) / 10_000_000;
                  boundaries.push({
                    type: item.Type,
                    start,
                    end: start + dur,
                    text: item.Data.text?.Text || '',
                  });
                }
              }
            } catch {
              // ignore metadata parse error
            }
          }
        }
      } else if (ev.data instanceof ArrayBuffer) {
        const buf = new Uint8Array(ev.data);
        if (buf.byteLength < 2) return;
        const headerLen = (buf[0] << 8) | buf[1];
        const audioStart = 2 + headerLen;
        if (audioStart < buf.byteLength) {
          audioChunks.push(buf.slice(audioStart));
        }
      }
    });

    ws.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Edge-TTS WebSocket connection error'));
      }
    });

    ws.addEventListener('close', () => {
      if (!settled) {
        if (audioChunks.length > 0) finish();
        else {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Edge-TTS WebSocket closed without audio'));
        }
      }
    });

    ws.send(configMsg);
    ws.send(ssmlMsg);
  });
}
