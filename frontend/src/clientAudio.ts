export interface WordBoundary {
  offset_sec: number;
  duration_sec: number;
  text: string;
}

export interface DecodedChunkAudio {
  bytes: Uint8Array;
  mimeType: string;
  text: string;
  speaker?: string | null;
  durationSec: number;
  boundaries?: WordBoundary[];
  pauseAfterMs: number;
}

export function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, Math.min(i + step, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function cleanTextForTts(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function smartChunkText(rawText: string, maxChars: number): string[] {
  const cleaned = cleanTextForTts(rawText);
  if (!cleaned) return [];

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];

  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      chunks.push(para);
      continue;
    }

    const sentences = para
      .split(/(?<=[.!?;:…])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    let current = '';
    for (const sentence of sentences) {
      if (sentence.length <= maxChars) {
        if (!current) {
          current = sentence;
        } else if (current.length + 1 + sentence.length <= maxChars) {
          current += ' ' + sentence;
        } else {
          chunks.push(current);
          current = sentence;
        }
        continue;
      }

      if (current) {
        chunks.push(current);
        current = '';
      }

      const clauses = sentence
        .split(/(?<=[,–—-])\s+/)
        .map((c) => c.trim())
        .filter(Boolean);

      let clauseBuf = '';
      for (const clause of clauses) {
        if (clause.length <= maxChars) {
          if (!clauseBuf) {
            clauseBuf = clause;
          } else if (clauseBuf.length + 1 + clause.length <= maxChars) {
            clauseBuf += ' ' + clause;
          } else {
            chunks.push(clauseBuf);
            clauseBuf = clause;
          }
          continue;
        }
        if (clauseBuf) {
          chunks.push(clauseBuf);
          clauseBuf = '';
        }
        const words = clause.split(/\s+/);
        let wordBuf = '';
        for (const w of words) {
          if (!wordBuf) {
            wordBuf = w;
          } else if (wordBuf.length + 1 + w.length <= maxChars) {
            wordBuf += ' ' + w;
          } else {
            chunks.push(wordBuf);
            wordBuf = w;
          }
        }
        if (wordBuf) chunks.push(wordBuf);
      }
      if (clauseBuf) chunks.push(clauseBuf);
    }
    if (current) chunks.push(current);
  }

  // Merge tiny trailing orphan fragments (< 28 chars) into neighbors so F5-TTS never hallucinates
  if (chunks.length > 1 && maxChars <= 200) {
    const merged: string[] = [];
    for (const ch of chunks) {
      if (merged.length > 0 && ch.length < 28 && merged[merged.length - 1].length + ch.length + 1 <= maxChars + 35) {
        merged[merged.length - 1] = `${merged[merged.length - 1]} ${ch}`;
      } else {
        merged.push(ch);
      }
    }
    return merged;
  }

  return chunks;
}

export function extractWaveformPeaks(samples: Float32Array, bars = 120): number[] {
  if (!samples.length) return Array(bars).fill(0.15);
  const step = Math.max(1, Math.floor(samples.length / bars));
  const raw: number[] = [];
  let maxVal = 1e-6;
  for (let i = 0; i < bars; i++) {
    const start = i * step;
    const end = Math.min(samples.length, start + step);
    let sumSq = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      const s = samples[j];
      sumSq += s * s;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    raw.push(rms);
    if (rms > maxVal) maxVal = rms;
  }
  return raw.map((v) => Math.max(0.08, Math.min(1, Number((v / maxVal).toFixed(3)))));
}

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function normalizeLinearPeakSafe(samples: Float32Array, targetDb = -20.0): Float32Array {
  let sumSq = 0;
  let activeCount = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a > 0.008) {
      sumSq += samples[i] * samples[i];
      activeCount++;
    }
  }
  if (peak < 1e-5 || activeCount < 64) return samples;

  const rms = Math.sqrt(sumSq / activeCount);
  const targetRms = Math.pow(10, targetDb / 20);
  let gain = targetRms / Math.max(rms, 1e-6);
  const maxSafeGain = 0.89 / peak;
  gain = Math.min(gain, maxSafeGain, 3.0);

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] * gain;
  }
  return out;
}

function trimEdgeSilence(
  pcm: Float32Array,
  sr: number,
  threshold = 0.009,
  keepLeadSec = 0.04,
  keepTailSec = 0.06
): Float32Array {
  if (pcm.length < sr * 0.2) return pcm;
  const win = Math.floor(sr * 0.015); // 15ms RMS window
  let start = 0;
  let end = pcm.length;

  for (let i = 0; i + win < pcm.length; i += Math.floor(win / 2)) {
    let sumSq = 0;
    for (let j = i; j < i + win; j++) sumSq += pcm[j] * pcm[j];
    if (Math.sqrt(sumSq / win) >= threshold) {
      start = Math.max(0, i - Math.floor(sr * keepLeadSec));
      break;
    }
  }

  for (let i = pcm.length - win; i >= start; i -= Math.floor(win / 2)) {
    let sumSq = 0;
    for (let j = i; j < i + win; j++) sumSq += pcm[j] * pcm[j];
    if (Math.sqrt(sumSq / win) >= threshold) {
      end = Math.min(pcm.length, i + win + Math.floor(sr * keepTailSec));
      break;
    }
  }

  if (end - start < sr * 0.15) return pcm;
  return pcm.slice(start, end);
}

/**
 * Finds the quietest natural pause valley between minSec and maxSec so reference audio
 * is NEVER sliced mid-word (which causes F5-TTS to hallucinate/bleed the cut word).
 */
function findSilenceCutPoint(pcm: Float32Array, sr: number, minSec: number, maxSec: number): number {
  const maxIdx = Math.min(pcm.length, Math.floor(maxSec * sr));
  const minIdx = Math.min(maxIdx, Math.floor(minSec * sr));
  if (pcm.length <= maxIdx) return pcm.length;

  const win = Math.floor(sr * 0.12); // 120ms valley window
  const step = Math.floor(sr * 0.02); // 20ms hop
  let bestCut = maxIdx;
  let lowestRms = Infinity;

  for (let i = minIdx; i + win <= maxIdx; i += step) {
    let sumSq = 0;
    for (let j = i; j < i + win; j++) sumSq += pcm[j] * pcm[j];
    const rms = Math.sqrt(sumSq / win);
    if (rms < lowestRms) {
      lowestRms = rms;
      bestCut = i + Math.floor(win / 2);
    }
  }
  return bestCut;
}

/**
 * Applies smooth fade-in/out and adds 200ms leading + 350ms trailing silence.
 * Clean trailing silence ensures Pho-Whisper transcribes the full final word and
 * F5-TTS cleanly terminates reference attention without bleeding the final syllable.
 */
function padReferenceSilence(pcm: Float32Array, sr: number, leadSec = 0.2, tailSec = 0.35): Float32Array {
  const faded = new Float32Array(pcm);
  const fadeSamples = Math.min(Math.floor(sr * 0.018), Math.floor(faded.length / 4));
  for (let i = 0; i < fadeSamples; i++) {
    const g = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
    faded[i] *= g;
    faded[faded.length - 1 - i] *= g;
  }

  const lead = Math.floor(sr * leadSec);
  const tail = Math.floor(sr * tailSec);
  const out = new Float32Array(lead + faded.length + tail);
  out.set(faded, lead);
  return out;
}

function estimatePitchHz(samples: Float32Array, sr: number): number {
  const frameLen = Math.min(samples.length, sr * 2);
  if (frameLen < 1024) return 155;
  const minLag = Math.floor(sr / 340);
  const maxLag = Math.floor(sr / 75);
  let bestLag = Math.floor(sr / 160);
  let bestCorr = -Infinity;

  const windowSize = 1024;
  const start = Math.floor((samples.length - windowSize - maxLag) / 2);
  if (start < 0) return 155;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < windowSize; i += 2) {
      corr += samples[start + i] * samples[start + i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  return Math.round(sr / bestLag);
}

async function decodeToMono24k(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const targetSr = 24000;
    const length = Math.max(1, Math.ceil(decoded.duration * targetSr));
    const offline = new OfflineAudioContext(1, length, targetSr);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Ensures any saved reference Blob (even from older sessions) meets F5-TTS-Vietnamese's
 * ideal 5–9s phrase-aligned window with clean 200ms lead + 350ms trailing silence.
 */
export async function ensureF5OptimalReference(blob: Blob): Promise<Blob> {
  try {
    const sr = 24000;
    const rawBuf = await blob.arrayBuffer();
    let pcm = await decodeToMono24k(rawBuf);

    // Check if trailing 280ms is already clean silence and total duration is <= 9.2s
    const tailCheckSamples = Math.min(pcm.length, Math.floor(sr * 0.28));
    let tailPeak = 0;
    for (let i = pcm.length - tailCheckSamples; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      if (a > tailPeak) tailPeak = a;
    }
    const durSec = pcm.length / sr;
    if (durSec <= 9.2 && tailPeak < 0.005) {
      return blob;
    }

    pcm = trimEdgeSilence(pcm, sr, 0.009, 0.05, 0.05);
    if (pcm.length > sr * 8.6) {
      const cutAt = findSilenceCutPoint(pcm, sr, 5.0, 8.6);
      pcm = pcm.slice(0, cutAt);
    }
    pcm = normalizeLinearPeakSafe(pcm, -20.0);
    pcm = padReferenceSilence(pcm, sr, 0.2, 0.35);
    return encodeWavPcm16(pcm, sr);
  } catch {
    return blob;
  }
}

export async function preprocessReferenceAudio(
  file: File,
  denoise: boolean
): Promise<{
  wavBlob: Blob;
  durationSec: number;
  qualityScore: number;
  qualityNote: string;
  pitchHz: number;
  waveformPeaks: number[];
}> {
  const rawBuf = await file.arrayBuffer();
  let pcm = await decodeToMono24k(rawBuf);
  const sr = 24000;

  // Trim excess leading/trailing silence cleanly using RMS windows
  pcm = trimEdgeSilence(pcm, sr, 0.009, 0.05, 0.06);

  // Smart silence-valley cut within 5.0–8.6s (optimal F5-TTS-Vietnamese window)
  if (pcm.length > sr * 8.6) {
    const cutAt = findSilenceCutPoint(pcm, sr, 5.0, 8.6);
    pcm = pcm.slice(0, cutAt);
  }

  // Optional gentle 80Hz high-pass if denoise is checked
  if (denoise && pcm.length > 100) {
    const out = new Float32Array(pcm.length);
    const alpha = 0.98;
    let prevIn = 0;
    let prevOut = 0;
    for (let i = 0; i < pcm.length; i++) {
      prevOut = alpha * (prevOut + pcm[i] - prevIn);
      prevIn = pcm[i];
      out[i] = prevOut;
    }
    pcm = out;
  }

  pcm = normalizeLinearPeakSafe(pcm, -20.0);
  const speechDurationSec = Number((pcm.length / sr).toFixed(2));
  const pitchHz = estimatePitchHz(pcm, sr);
  const waveformPeaks = extractWaveformPeaks(pcm, 96);

  // Pad clean 200ms leading + 350ms trailing silence to prevent word bleed on F5-TTS
  const paddedPcm = padReferenceSilence(pcm, sr, 0.2, 0.35);

  let qualityScore = 90;
  let qualityNote = 'Chuẩn F5-TTS Việt 6000h — đã căn ngắt câu và đệm lặng chống dính từ.';
  if (speechDurationSec < 3.0) {
    qualityScore = 68;
    qualityNote = 'Mẫu hơi ngắn (< 3s). Nên thu 5–8 giây kết thúc trọn câu để F5-TTS đọc chuẩn nhất.';
  } else if (speechDurationSec >= 4.5 && speechDurationSec <= 8.8) {
    qualityScore = 96;
    qualityNote = 'Độ dài vàng (5–9s) cho F5-TTS Việt — đã đệm khoảng lặng sạch chống dính từ đầu câu.';
  }

  const wavBlob = encodeWavPcm16(paddedPcm, sr);
  return {
    wavBlob,
    durationSec: speechDurationSec,
    qualityScore,
    qualityNote,
    pitchHz,
    waveformPeaks,
  };
}

function formatSrtTime(sec: number): string {
  const msTotal = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(msTotal / 3600000);
  const m = Math.floor((msTotal % 3600000) / 60000);
  const s = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatVttTime(sec: number): string {
  return formatSrtTime(sec).replace(',', '.');
}

export function buildSubtitles(
  cues: Array<{ start: number; end: number; text: string }>
): { srtText: string; vttText: string } {
  const srtLines: string[] = [];
  const vttLines: string[] = ['WEBVTT', ''];

  cues.forEach((cue, i) => {
    const clean = cue.text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    srtLines.push(String(i + 1));
    srtLines.push(`${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`);
    srtLines.push(clean);
    srtLines.push('');

    vttLines.push(`${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}`);
    vttLines.push(clean);
    vttLines.push('');
  });

  return {
    srtText: srtLines.join('\n'),
    vttText: vttLines.join('\n'),
  };
}

export async function stitchAudioChunks(
  chunks: DecodedChunkAudio[],
  options: {
    outputFormat: 'mp3' | 'wav';
    normalizeAudio: boolean;
    generateSubtitles: boolean;
  }
): Promise<{
  audioBlob: Blob;
  actualFormat: 'mp3' | 'wav';
  durationSec: number;
  waveformPeaks: number[];
  srtText?: string;
  vttText?: string;
}> {
  if (chunks.length === 0) {
    throw new Error('Không có đoạn âm thanh nào để ghép nối.');
  }

  const allMp3 = chunks.every((c) => c.mimeType === 'audio/mpeg');
  const cues: Array<{ start: number; end: number; text: string }> = [];

  // Fast, lossless native MP3 concatenation path for Edge-TTS when user chooses MP3
  if (allMp3 && options.outputFormat === 'mp3') {
    let totalBytes = 0;
    for (const c of chunks) totalBytes += c.bytes.length;
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    let cursorSec = 0;

    for (const c of chunks) {
      merged.set(c.bytes, offset);
      offset += c.bytes.length;

      const chunkDur = c.durationSec > 0 ? c.durationSec : c.bytes.length / 6000;
      if (options.generateSubtitles) {
        if (c.boundaries && c.boundaries.length > 0) {
          let groupWords: string[] = [];
          let groupStart = cursorSec + c.boundaries[0].offset_sec;
          let groupEnd = groupStart + c.boundaries[0].duration_sec;

          for (const b of c.boundaries) {
            const bStart = cursorSec + b.offset_sec;
            const bEnd = bStart + Math.max(0.08, b.duration_sec);
            if (groupWords.length >= 10 || (groupWords.length > 0 && bStart - groupStart > 3.8)) {
              cues.push({
                start: groupStart,
                end: Math.max(groupEnd, groupStart + 0.3),
                text: (c.speaker ? `${c.speaker}: ` : '') + groupWords.join(' '),
              });
              groupWords = [];
              groupStart = bStart;
            }
            groupWords.push(b.text);
            groupEnd = bEnd;
          }
          if (groupWords.length > 0) {
            cues.push({
              start: groupStart,
              end: Math.max(groupEnd, groupStart + 0.3),
              text: (c.speaker ? `${c.speaker}: ` : '') + groupWords.join(' '),
            });
          }
        } else {
          cues.push({
            start: cursorSec,
            end: cursorSec + chunkDur,
            text: (c.speaker ? `${c.speaker}: ` : '') + c.text,
          });
        }
      }
      cursorSec += chunkDur;
    }

    const mp3Blob = new Blob([merged], { type: 'audio/mpeg' });
    let durationSec = Number(cursorSec.toFixed(2));
    let waveformPeaks: number[] = Array(120)
      .fill(0)
      .map((_, i) => 0.25 + 0.55 * Math.abs(Math.sin(i * 0.35)));

    if (merged.length <= 20 * 1024 * 1024) {
      try {
        const pcm = await decodeToMono24k(merged.buffer.slice(0));
        durationSec = Number((pcm.length / 24000).toFixed(2));
        waveformPeaks = extractWaveformPeaks(pcm, 160);
      } catch {
        // Keep estimated duration and waveform
      }
    }

    const subs = options.generateSubtitles ? buildSubtitles(cues) : undefined;
    return {
      audioBlob: mp3Blob,
      actualFormat: 'mp3',
      durationSec,
      waveformPeaks,
      srtText: subs?.srtText,
      vttText: subs?.vttText,
    };
  }

  // High-precision PCM WAV stitcher (for F5-TTS Việt Voice Cloning, WAV export, and mixed Dialogue)
  const sr = 24000;
  const decodedList: Float32Array[] = [];
  for (const c of chunks) {
    let pcm = await decodeToMono24k(
      c.bytes.buffer.slice(c.bytes.byteOffset, c.bytes.byteOffset + c.bytes.byteLength)
    );
    // Trim dead leading/trailing silence on each F5-TTS chunk so rhythm matches pause_ms cleanly
    pcm = trimEdgeSilence(pcm, sr, 0.008, 0.045, 0.065);
    // Gentle 15ms cosine fade-in / fade-out to prevent clicks/pops at boundaries
    const fadeSamples = Math.min(Math.floor(sr * 0.015), Math.floor(pcm.length / 4));
    for (let i = 0; i < fadeSamples; i++) {
      const gain = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
      pcm[i] *= gain;
      pcm[pcm.length - 1 - i] *= gain;
    }
    decodedList.push(pcm);
  }

  let totalSamples = 0;
  for (let i = 0; i < decodedList.length; i++) {
    totalSamples += decodedList[i].length;
    if (i < decodedList.length - 1) {
      totalSamples += Math.round((sr * Math.max(0, chunks[i].pauseAfterMs)) / 1000);
    }
  }

  const combined = new Float32Array(totalSamples);
  let writePos = 0;
  for (let i = 0; i < decodedList.length; i++) {
    const seg = decodedList[i];
    const startSec = writePos / sr;
    combined.set(seg, writePos);
    writePos += seg.length;
    const endSec = writePos / sr;

    if (options.generateSubtitles) {
      cues.push({
        start: startSec,
        end: endSec,
        text: (chunks[i].speaker ? `${chunks[i].speaker}: ` : '') + chunks[i].text,
      });
    }

    if (i < decodedList.length - 1) {
      writePos += Math.round((sr * Math.max(0, chunks[i].pauseAfterMs)) / 1000);
    }
  }

  const finalPcm = options.normalizeAudio ? normalizeLinearPeakSafe(combined, -20.0) : combined;
  const wavBlob = encodeWavPcm16(finalPcm, sr);
  const durationSec = Number((finalPcm.length / sr).toFixed(2));
  const waveformPeaks = extractWaveformPeaks(finalPcm, 160);
  const subs = options.generateSubtitles ? buildSubtitles(cues) : undefined;

  return {
    audioBlob: wavBlob,
    actualFormat: 'wav',
    durationSec,
    waveformPeaks,
    srtText: subs?.srtText,
    vttText: subs?.vttText,
  };
}
