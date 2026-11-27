import React, { useState } from 'react';
import { Loader2, Play, Plus, Trash2 } from 'lucide-react';
import type {
  ClonedVoiceProfile,
  DialogueLine,
  DialoguePayload,
  EngineId,
  JobRecord,
  StockVoiceInfo,
} from '../types';

interface DialogueDirectorProps {
  stockVoicesByEngine: Record<string, StockVoiceInfo[]>;
  clonedVoices: ClonedVoiceProfile[];
  activeJob: JobRecord | null;
  onStartDialogue: (payload: DialoguePayload) => Promise<void>;
  onPlayTrack: (job: JobRecord) => void;
}

function makeId() {
  return `line_${Math.random().toString(36).slice(2, 9)}`;
}

const TEMPLATES: { name: string; title: string; lines: Omit<DialogueLine, 'id'>[] }[] = [
  {
    name: 'Podcast công nghệ',
    title: 'Podcast: Tương lai giọng nói AI',
    lines: [
      {
        speaker: 'MC Hoài My',
        text: 'Xin chào quý vị đang lắng nghe chương trình Công nghệ hôm nay. Chủ đề của tập này là tổng hợp và nhân bản giọng nói không giới hạn độ dài.',
        engine: 'edge',
        voice_id: 'vi-VN-HoaiMyNeural',
        cloned_voice_id: null,
        speed: 1.0,
        pitch: 0,
        pause_after_ms: 420,
      },
      {
        speaker: 'Nam Minh',
        text: 'Cảm ơn Hoài My. Điểm hay nhất là chúng ta có thể kết hợp giọng nhân bản cá nhân với các mô hình chạy trực tiếp trên máy tính mà vẫn giữ âm thanh rõ và tự nhiên.',
        engine: 'edge',
        voice_id: 'vi-VN-NamMinhNeural',
        cloned_voice_id: null,
        speed: 1.0,
        pitch: 0,
        pause_after_ms: 420,
      },
      {
        speaker: 'MC Hoài My',
        text: 'Và toàn bộ lời thoại của nhiều nhân vật sẽ được ghép liền mạch kèm phụ đề đồng bộ chỉ trong một lần xuất.',
        engine: 'edge',
        voice_id: 'vi-VN-HoaiMyNeural',
        cloned_voice_id: null,
        speed: 1.02,
        pitch: 0,
        pause_after_ms: 300,
      },
    ],
  },
  {
    name: 'Hội thoại song ngữ',
    title: 'Bilingual studio demo',
    lines: [
      {
        speaker: 'Host (English)',
        text: 'Welcome to VoxForge. Each line in this script can use a different neural or cloned voice, seamlessly mastered into one file.',
        engine: 'edge',
        voice_id: 'en-US-AndrewMultilingualNeural',
        cloned_voice_id: null,
        speed: 1.0,
        pitch: 0,
        pause_after_ms: 400,
      },
      {
        speaker: 'Biên tập viên',
        text: 'Bạn có thể phối giọng clone của chính mình vào vai MC hoặc khách mời, đồng thời xuất sẵn tệp phụ đề SRT.',
        engine: 'edge',
        voice_id: 'vi-VN-HoaiMyNeural',
        cloned_voice_id: null,
        speed: 1.0,
        pitch: 0,
        pause_after_ms: 350,
      },
    ],
  },
];

export const DialogueDirector: React.FC<DialogueDirectorProps> = ({
  stockVoicesByEngine,
  clonedVoices,
  activeJob,
  onStartDialogue,
  onPlayTrack,
}) => {
  const [title, setTitle] = useState(TEMPLATES[0].title);
  const [lines, setLines] = useState<DialogueLine[]>(() =>
    TEMPLATES[0].lines.map((l) => ({ ...l, id: makeId() }))
  );
  const [outputFormat, setOutputFormat] = useState<'mp3' | 'wav'>('mp3');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRunning =
    activeJob &&
    activeJob.mode === 'dialogue' &&
    (activeJob.status === 'queued' || activeJob.status === 'running' || activeJob.status === 'stitching');

  const updateLine = (id: string, patch: Partial<DialogueLine>) => {
    setLines((prev) => prev.map((ln) => (ln.id === id ? { ...ln, ...patch } : ln)));
  };

  const addLine = () => {
    const last = lines[lines.length - 1];
    const nextSpeaker = last?.speaker === 'MC Hoài My' ? 'Nam Minh' : 'MC Hoài My';
    const nextVoice = nextSpeaker === 'Nam Minh' ? 'vi-VN-NamMinhNeural' : 'vi-VN-HoaiMyNeural';
    setLines((prev) => [
      ...prev,
      {
        id: makeId(),
        speaker: nextSpeaker,
        text: '',
        engine: 'edge',
        voice_id: nextVoice,
        cloned_voice_id: null,
        speed: 1.0,
        pitch: 0,
        pause_after_ms: 380,
      },
    ]);
  };

  const removeLine = (id: string) => {
    if (lines.length <= 1) return;
    setLines((prev) => prev.filter((ln) => ln.id !== id));
  };

  const handleGenerate = async () => {
    const validLines = lines.filter((l) => l.text.trim().length > 0);
    if (validLines.length === 0) {
      setError('Nhập nội dung cho ít nhất một lượt thoại.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onStartDialogue({
        title: title.trim() || 'Hội thoại Podcast',
        lines: validLines,
        output_format: outputFormat,
        normalize_audio: true,
        generate_subtitles: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể dựng hội thoại.');
    } finally {
      setSubmitting(false);
    }
  };

  const edgeVoices = stockVoicesByEngine['edge'] || [];
  const vieneuVoices = stockVoicesByEngine['vieneu'] || [];

  return (
    <div className="max-w-4xl mx-auto px-6 lg:px-10 py-8 pb-32 space-y-6">
      <div className="border-b border-[#E5E7EB] pb-5 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-[#111315]">
            Hội thoại Podcast
          </h1>
          <p className="text-[14px] text-[#5C626E] mt-1">
            Phối nhiều nhân vật bằng giọng có sẵn và giọng Clone cá nhân trong cùng một bản thu.
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.name}
              onClick={() => {
                setTitle(tpl.title);
                setLines(tpl.lines.map((l) => ({ ...l, id: makeId() })));
              }}
              className="px-2.5 py-1.5 rounded-md btn-secondary text-xs font-medium cursor-pointer"
            >
              Mẫu: {tpl.name}
            </button>
          ))}
        </div>
      </div>

      {/* Header Action Bar */}
      <div className="panel rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Tên tập Podcast hoặc kịch bản"
          className="text-[15px] font-semibold text-[#111315] placeholder-[#9CA3AF] bg-transparent focus:outline-none flex-1 min-w-[200px]"
        />
        <div className="flex items-center gap-2">
          <select
            value={outputFormat}
            onChange={(e) => setOutputFormat(e.target.value as 'mp3' | 'wav')}
            className="px-2.5 py-2 rounded-lg bg-white border border-[#DCDFE4] text-xs font-mono-tech text-[#111315]"
          >
            <option value="mp3">MP3 · 192 kbps</option>
            <option value="wav">WAV · Lossless</option>
          </select>
          <button
            onClick={handleGenerate}
            disabled={submitting || Boolean(isRunning)}
            className="px-4 py-2 rounded-lg btn-primary text-xs font-semibold flex items-center gap-2 disabled:cursor-not-allowed cursor-pointer"
          >
            {submitting || isRunning ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Đang dựng ({Math.round(activeJob?.progress || 0)}%)</span>
              </>
            ) : (
              <span>Dựng hội thoại ({lines.length} lượt)</span>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-[#991B1B] text-xs">
          {error}
        </div>
      )}

      {activeJob &&
        activeJob.mode === 'dialogue' &&
        activeJob.status === 'completed' &&
        activeJob.audio_url && (
          <div className="p-4 rounded-xl bg-[#F0FDF4] border border-[#BBF7D0] flex items-center justify-between gap-4">
            <div>
              <div className="text-[13.5px] font-semibold text-[#166534]">
                Đã dựng xong: {activeJob.title}
              </div>
              <div className="text-xs text-[#15803D] mt-0.5">
                {activeJob.total_chunks} lượt thoại · {activeJob.duration_sec}s · Có sẵn phụ đề SRT
              </div>
            </div>
            <button
              onClick={() => onPlayTrack(activeJob)}
              className="px-3.5 py-1.5 rounded-lg btn-primary text-xs font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              Nghe bản thu
            </button>
          </div>
        )}

      {/* Dialogue Turns */}
      <div className="space-y-3">
        {lines.map((ln, idx) => {
          const isClonedChoice = Boolean(ln.cloned_voice_id);
          return (
            <div key={ln.id} className="panel rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-mono-tech text-xs text-[#8C929D] w-6 shrink-0">
                  {String(idx + 1).padStart(2, '0')}
                </span>

                <input
                  type="text"
                  value={ln.speaker}
                  onChange={(e) => updateLine(ln.id, { speaker: e.target.value })}
                  placeholder="Tên nhân vật"
                  className="px-2.5 py-1.5 rounded-lg bg-[#FAFAFB] border border-[#DCDFE4] text-xs font-semibold text-[#111315] w-36 focus:outline-none focus:border-[#111315]"
                />

                <select
                  value={
                    isClonedChoice
                      ? `cloned::${ln.engine}::${ln.cloned_voice_id}`
                      : `stock::${ln.engine}::${ln.voice_id}`
                  }
                  onChange={(e) => {
                    const [kind, eng, id] = e.target.value.split('::');
                    if (kind === 'cloned') {
                      updateLine(ln.id, {
                        engine: eng as EngineId,
                        cloned_voice_id: id,
                        voice_id: 'vi-VN-HoaiMyNeural',
                      });
                    } else {
                      updateLine(ln.id, {
                        engine: eng as EngineId,
                        cloned_voice_id: null,
                        voice_id: id,
                      });
                    }
                  }}
                  className="flex-1 min-w-[210px] px-2.5 py-1.5 rounded-lg bg-white border border-[#DCDFE4] text-xs text-[#111315] focus:outline-none focus:border-[#111315]"
                >
                  {clonedVoices.length > 0 && (
                    <optgroup label="Giọng Clone (ViZipVoice 7000h — Giống thật 99% Offline)">
                      {clonedVoices.map((cv) => (
                        <option key={`vz_${cv.id}`} value={`cloned::vizipvoice::${cv.id}`}>
                          Clone 99% · {cv.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {clonedVoices.length > 0 && (
                    <optgroup label="Giọng Clone (ZipVoice GPU Cloud)">
                      {clonedVoices.map((cv) => (
                        <option key={`vzg_${cv.id}`} value={`cloned::zipvoice_gpu::${cv.id}`}>
                          Clone GPU · {cv.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {clonedVoices.length > 0 && (
                    <optgroup label="Giọng Clone Nhanh (VieNeu Nano CPU)">
                      {clonedVoices.map((cv) => (
                        <option key={`vn_${cv.id}`} value={`cloned::vieneu::${cv.id}`}>
                          Clone Nhanh · {cv.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Giọng Edge Neural">
                    {edgeVoices.slice(0, 35).map((v) => (
                      <option key={`ed_${v.id}`} value={`stock::edge::${v.id}`}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Giọng VieNeu tiếng Việt (Offline)">
                    {vieneuVoices.map((v) => (
                      <option key={`vnst_${v.id}`} value={`stock::vieneu::${v.id}`}>
                        VieNeu · {v.name}
                      </option>
                    ))}
                  </optgroup>
                </select>

                <div className="flex items-center gap-1.5 text-xs text-[#717784] font-mono-tech">
                  <span>Nghỉ</span>
                  <input
                    type="number"
                    min={0}
                    max={3000}
                    step={50}
                    value={ln.pause_after_ms}
                    onChange={(e) => updateLine(ln.id, { pause_after_ms: Number(e.target.value) })}
                    className="w-16 px-2 py-1 rounded-md bg-[#FAFAFB] border border-[#DCDFE4] text-[#111315] text-center"
                  />
                  <span>ms</span>
                </div>

                <button
                  onClick={() => removeLine(ln.id)}
                  disabled={lines.length <= 1}
                  className="p-1.5 rounded-md text-[#8C929D] hover:text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-30 cursor-pointer"
                  title="Xóa lượt thoại"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <textarea
                value={ln.text}
                onChange={(e) => updateLine(ln.id, { text: e.target.value })}
                rows={2}
                placeholder="Nhập lời thoại cho nhân vật này..."
                className="w-full px-3 py-2 rounded-lg bg-[#FAFAFB] border border-[#ECEEF2] text-[14px] leading-relaxed text-[#111315] placeholder-[#9CA3AF] focus:outline-none focus:bg-white focus:border-[#111315] resize-y"
              />
            </div>
          );
        })}

        <button
          onClick={addLine}
          className="w-full py-2.5 rounded-xl border border-dashed border-[#C4C9D1] hover:border-[#111315] bg-white text-[#525866] hover:text-[#111315] text-xs font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Thêm lượt thoại
        </button>
      </div>
    </div>
  );
};
