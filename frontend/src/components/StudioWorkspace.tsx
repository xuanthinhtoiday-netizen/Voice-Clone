import React, { useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  FileUp,
  Fingerprint,
  Loader2,
  Play,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type {
  ClonedVoiceProfile,
  EngineId,
  EngineStatus,
  JobRecord,
  StockVoiceInfo,
  SynthesizePayload,
} from '../types';

interface StudioWorkspaceProps {
  engines: EngineStatus[];
  stockVoicesByEngine: Record<string, StockVoiceInfo[]>;
  clonedVoices: ClonedVoiceProfile[];
  activeJob: JobRecord | null;
  selectedClonedId: string | null;
  onSelectClonedId: (id: string | null) => void;
  onStartSynthesis: (payload: SynthesizePayload) => Promise<void>;
  onCancelJob: (jobId: string) => void;
  onPlayTrack: (job: JobRecord) => void;
  onGoToVault: () => void;
  onGoToEngines: () => void;
}

const SAMPLE_SCRIPTS = [
  {
    label: 'Bài thuyết minh tiếng Việt',
    text: `Chào mừng bạn đến với VoxForge — không gian làm việc dành cho tổng hợp và nhân bản giọng nói không giới hạn độ dài văn bản.

Bạn có thể dán một đoạn kịch bản ngắn hoặc toàn bộ bản thảo dài hàng trăm nghìn ký tự. Hệ thống tự động chia đoạn theo đúng ngữ điệu dấu câu, duy trì nhịp thở tự nhiên giữa các đoạn văn và ghép nối liền mạch thành một bản thu hoàn chỉnh.

Khi cần giọng đọc mang dấu ấn riêng, hãy chuyển sang Kho giọng Clone để thu mẫu 5 đến 10 giây, sau đó dùng chính giọng nói đó đọc mọi văn bản bạn muốn.`,
  },
  {
    label: 'Truyện ngắn đêm khuya',
    text: `Đêm nay mưa rơi nhè nhẹ trên mái hiên phố cũ. Trong căn phòng nhỏ chỉ còn ánh đèn vàng hắt lên trang sách đang mở dở, từng giọt thời gian dường như trôi chậm lại.

Có những câu chuyện ta nghe qua một lần rồi quên, nhưng cũng có những thanh âm ấm áp theo ta suốt cả một chặng đường dài. Hãy hít một hơi thật sâu, thả lỏng đôi vai và lắng nghe hành trình sắp bắt đầu.`,
  },
  {
    label: 'English narration sample',
    text: `Welcome to VoxForge, an unlimited-length speech synthesis and voice cloning workstation running directly on your computer.

Long scripts are segmented cleanly at natural sentence boundaries, synthesized chunk by chunk with consistent prosody, and mastered automatically with optional SRT subtitles.`,
  },
];

export const StudioWorkspace: React.FC<StudioWorkspaceProps> = ({
  engines,
  stockVoicesByEngine,
  clonedVoices,
  activeJob,
  selectedClonedId,
  onSelectClonedId,
  onStartSynthesis,
  onCancelJob,
  onPlayTrack,
  onGoToVault,
  onGoToEngines,
}) => {
  const [title, setTitle] = useState('');
  const [text, setText] = useState(SAMPLE_SCRIPTS[0].text);
  const [engine, setEngine] = useState<EngineId>(selectedClonedId ? 'vizipvoice' : 'edge');
  const [voiceMode, setVoiceMode] = useState<'stock' | 'cloned'>(selectedClonedId ? 'cloned' : 'stock');

  const [selectedStockVoice, setSelectedStockVoice] = useState<Record<string, string>>({
    edge: 'vi-VN-HoaiMyNeural',
    vieneu: 'Minh Quân',
    kokoro: 'af_heart',
    hybrid_clone: 'vi-VN-HoaiMyNeural',
  });

  const [blendEnabled, setBlendEnabled] = useState(false);
  const [blendVoiceId, setBlendVoiceId] = useState('af_bella');
  const [blendRatio, setBlendRatio] = useState(0.6);

  const [voiceQuery, setVoiceQuery] = useState('');
  const [langFilter, setLangFilter] = useState<'all' | 'vi' | 'en' | 'multi'>('all');

  const [speed, setSpeed] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [pauseMs, setPauseMs] = useState(240);
  const [cloneStrength, setCloneStrength] = useState(0.85);
  const [qualityMode, setQualityMode] = useState<'turbo' | 'balanced' | 'high'>('turbo');
  const [outputFormat, setOutputFormat] = useState<'mp3' | 'wav'>('mp3');
  const [normalizeAudio, setNormalizeAudio] = useState(true);
  const [generateSubtitles, setGenerateSubtitles] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showChunks, setShowChunks] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const availableCloneOptions = useMemo(() => {
    const hasLocal = engines.some((e) => e.id === 'vizipvoice');
    if (hasLocal) {
      return [
        { id: 'f5_gpu' as EngineId, label: 'F5-TTS Việt 6000h', sub: 'Flow-Matching · GPU Cloud' },
        { id: 'vizipvoice' as EngineId, label: 'ViZipVoice', sub: 'Offline CPU' },
      ];
    }
    return [
      {
        id: 'f5_gpu' as EngineId,
        label: 'F5-TTS Việt 6000h',
        sub: 'Flow-Matching · Chuẩn âm sắc · Chống nuốt chữ',
      },
    ];
  }, [engines]);

  const availableStockOptions = useMemo(() => {
    const hasLocalStock = engines.some((e) => e.id === 'vieneu' || e.id === 'kokoro');
    if (hasLocalStock) {
      return [
        { id: 'edge' as EngineId, label: 'Edge Neural', sub: '300+ giọng' },
        { id: 'vieneu' as EngineId, label: 'VieNeu VN', sub: 'Offline CPU' },
        { id: 'kokoro' as EngineId, label: 'Kokoro 82M', sub: 'Trộn giọng' },
      ];
    }
    return [{ id: 'edge' as EngineId, label: 'Edge Neural Cloud', sub: '300+ giọng · Hono.js Worker' }];
  }, [engines]);

  const defaultCloneEngine = availableCloneOptions[0]?.id || 'f5_gpu';

  React.useEffect(() => {
    if (selectedClonedId) {
      setVoiceMode('cloned');
      const validCloneIds = availableCloneOptions.map((o) => o.id);
      if (!validCloneIds.includes(engine)) {
        setEngine(defaultCloneEngine);
      }
    }
  }, [selectedClonedId, availableCloneOptions, defaultCloneEngine]);

  React.useEffect(() => {
    if (voiceMode === 'cloned') {
      const validCloneIds = availableCloneOptions.map((o) => o.id);
      if (!validCloneIds.includes(engine)) setEngine(defaultCloneEngine);
    } else {
      const validStockIds = availableStockOptions.map((o) => o.id);
      if (!validStockIds.includes(engine)) setEngine('edge');
    }
  }, [engines, voiceMode, availableCloneOptions, availableStockOptions, defaultCloneEngine]);

  const isRunning =
    activeJob &&
    (activeJob.status === 'queued' || activeJob.status === 'running' || activeJob.status === 'stitching');

  const currentStockVoices = stockVoicesByEngine[engine] || stockVoicesByEngine['edge'] || [];

  const filteredStockVoices = useMemo(() => {
    const q = voiceQuery.trim().toLowerCase();
    return currentStockVoices.filter((v) => {
      if (langFilter === 'vi' && !v.locale.toLowerCase().startsWith('vi')) return false;
      if (langFilter === 'en' && !v.locale.toLowerCase().startsWith('en')) return false;
      if (langFilter === 'multi' && !v.id.toLowerCase().includes('multilingual')) return false;
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        v.id.toLowerCase().includes(q) ||
        v.language.toLowerCase().includes(q)
      );
    });
  }, [currentStockVoices, voiceQuery, langFilter]);

  const activeClonedProfile = useMemo(
    () => clonedVoices.find((v) => v.id === selectedClonedId) || clonedVoices[0] || null,
    [clonedVoices, selectedClonedId]
  );

  const stats = useMemo(() => {
    const trimmed = text.trim();
    const chars = trimmed.length;
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const chunkSize =
      engine === 'f5_gpu'
        ? 135
        : engine === 'vizipvoice'
          ? 160
          : engine === 'vieneu'
            ? 240
            : engine === 'kokoro'
              ? 420
              : 1000;
    const estChunks = chars === 0 ? 0 : Math.max(1, Math.ceil(chars / chunkSize));
    const estSeconds = Math.round(words / 2.6 / Math.max(speed, 0.5));
    return { chars, words, estChunks, estSeconds };
  }, [text, engine, speed]);

  const engineMeta = engines.find((e) => e.id === engine);

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await api.extractTextFromFile(file);
      setText(res.text);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
      setLocalError(null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Không đọc được tệp văn bản.');
    } finally {
      e.target.value = '';
    }
  };

  const insertAtCursor = (snippet: string) => {
    const el = textareaRef.current;
    if (!el) {
      setText((prev) => prev + snippet);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const handleForge = async () => {
    if (!text.trim()) {
      setLocalError('Nhập văn bản cần đọc trước khi bắt đầu.');
      return;
    }
    if (voiceMode === 'cloned' && !activeClonedProfile) {
      setLocalError('Chưa có giọng clone. Tạo mẫu giọng trong Kho giọng Clone trước.');
      return;
    }
    if (engine === 'kokoro' && engineMeta && !engineMeta.ready) {
      setLocalError('Mô hình Kokoro-82M chưa được tải. Vào mục Mô hình AI để tải về máy.');
      return;
    }

    setLocalError(null);
    setSubmitting(true);
    try {
      const validCloneIds = availableCloneOptions.map((o) => o.id);
      const effectiveEngine: EngineId =
        voiceMode === 'cloned' && !validCloneIds.includes(engine)
          ? defaultCloneEngine
          : engine;

      const payload: SynthesizePayload = {
        title: title.trim() || undefined,
        text,
        engine: effectiveEngine,
        voice_id:
          selectedStockVoice[effectiveEngine] || currentStockVoices[0]?.id || 'vi-VN-HoaiMyNeural',
        cloned_voice_id: voiceMode === 'cloned' ? activeClonedProfile?.id || null : null,
        speed,
        pitch,
        volume: 0,
        pause_ms: pauseMs,
        crossfade_ms: 45,
        output_format: outputFormat,
        normalize_audio: normalizeAudio,
        generate_subtitles: generateSubtitles,
        blend_voice_id: effectiveEngine === 'kokoro' && blendEnabled ? blendVoiceId : null,
        blend_ratio: blendRatio,
        clone_strength: cloneStrength,
        quality_mode: qualityMode,
      };
      await onStartSynthesis(payload);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Không thể bắt đầu tạo giọng nói.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col xl:flex-row pb-24 lg:pb-20">
      {/* LEFT / MAIN WRITING CANVAS — Full-bleed paper workstation */}
      <div className="flex-1 min-w-0 bg-white flex flex-col">
        {/* Top Document Toolbar */}
        <div className="h-14 px-6 border-b border-[#E5E7EB] flex items-center justify-between gap-4 shrink-0">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Bản thảo chưa đặt tên"
            className="text-[15px] font-semibold text-[#111315] placeholder-[#9CA3AF] bg-transparent focus:outline-none flex-1 min-w-0"
          />

          <div className="flex items-center gap-2 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.srt,.vtt"
              className="hidden"
              onChange={handleFileImport}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-2.5 py-1.5 rounded-md btn-secondary text-xs font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <FileUp className="w-3.5 h-3.5 text-[#525866]" />
              <span>Nhập tệp</span>
            </button>

            <select
              onChange={(e) => {
                const idx = Number(e.target.value);
                if (!Number.isNaN(idx) && SAMPLE_SCRIPTS[idx]) {
                  setText(SAMPLE_SCRIPTS[idx].text);
                }
                e.target.value = '';
              }}
              defaultValue=""
              className="px-2.5 py-1.5 rounded-md bg-white border border-[#DCDFE4] text-xs font-medium text-[#3F444E] focus:outline-none cursor-pointer hover:bg-[#F4F5F7]"
            >
              <option value="" disabled>
                Văn bản mẫu
              </option>
              {SAMPLE_SCRIPTS.map((s, i) => (
                <option key={s.label} value={i}>
                  {s.label}
                </option>
              ))}
            </select>

            {text.length > 0 && (
              <button
                onClick={() => setText('')}
                className="p-1.5 rounded-md text-[#8C929D] hover:text-[#DC2626] hover:bg-[#FEF2F2] transition-colors cursor-pointer"
                title="Xóa toàn bộ văn bản"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Distraction-Free Editorial Writing Canvas */}
        <div className="flex-1 flex flex-col px-6 lg:px-10 py-6 max-w-[820px] w-full">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Nhập hoặc dán văn bản của bạn vào đây. Không giới hạn độ dài ký tự — hệ thống sẽ tự động phân đoạn theo câu và ghép nối mượt mà..."
            className="flex-1 w-full min-h-[380px] bg-transparent text-[15.5px] leading-[1.8] text-[#111315] placeholder-[#A1A7B3] focus:outline-none resize-none"
          />

          {/* Subtle Inline Writing Bar */}
          <div className="pt-4 mt-4 border-t border-[#ECEEF2] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11.5px] text-[#8C929D] mr-1">Ngữ điệu:</span>
              {[
                { label: 'Cười nhẹ', tag: ' [cười] ' },
                { label: 'Thở dài', tag: ' [thở dài] ' },
                { label: 'Ngắt đoạn', tag: '\n\n' },
              ].map((t) => (
                <button
                  key={t.label}
                  onClick={() => insertAtCursor(t.tag)}
                  className="px-2 py-1 rounded-md bg-[#F4F5F7] hover:bg-[#E5E7EB] text-[11.5px] font-medium text-[#3F444E] transition-colors cursor-pointer"
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3 text-[12px] font-mono-tech text-[#717784]">
              <span>
                <strong className="text-[#111315] font-medium">
                  {stats.chars.toLocaleString()}
                </strong>{' '}
                ký tự (không giới hạn)
              </span>
              <span>·</span>
              <span>{stats.estChunks} đoạn</span>
              <span>·</span>
              <span>
                ~{Math.floor(stats.estSeconds / 60)}:{String(stats.estSeconds % 60).padStart(2, '0')}
              </span>
            </div>
          </div>

          {/* Inline Error Alert */}
          {localError && (
            <div className="mt-4 px-3.5 py-2.5 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-[#991B1B] text-[13px] flex items-center justify-between gap-3">
              <span>{localError}</span>
              {engine === 'kokoro' && engineMeta && !engineMeta.ready && (
                <button
                  onClick={onGoToEngines}
                  className="text-xs font-semibold underline shrink-0 cursor-pointer"
                >
                  Mở Mô hình AI
                </button>
              )}
            </div>
          )}

          {/* Active Synthesis Progress Strip (only visible when a job exists) */}
          {activeJob && (
            <div className="mt-5 rounded-xl border border-[#E5E7EB] bg-[#FAFAFB] p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2.5 min-w-0">
                  {isRunning ? (
                    <Loader2 className="w-4 h-4 text-[#111315] animate-spin shrink-0" />
                  ) : (
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        activeJob.status === 'completed'
                          ? 'bg-[#15803D]'
                          : activeJob.status === 'error'
                            ? 'bg-[#DC2626]'
                            : 'bg-[#8C929D]'
                      }`}
                    />
                  )}
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-[#111315] truncate">
                      {activeJob.title}
                      <span className="font-normal text-[#717784] ml-2">{activeJob.voice_name}</span>
                    </div>
                    <div className="text-[12px] text-[#5C626E]">
                      {activeJob.status === 'running' &&
                        `Đang xử lý đoạn ${activeJob.current_chunk}/${activeJob.total_chunks}`}
                      {activeJob.status === 'stitching' && 'Đang ghép nối và cân bằng âm lượng...'}
                      {activeJob.status === 'completed' &&
                        `Hoàn tất · ${activeJob.total_chunks} đoạn · ${activeJob.duration_sec}s`}
                      {activeJob.status === 'error' && activeJob.error}
                      {activeJob.status === 'cancelled' && 'Đã hủy tiến trình.'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono-tech text-xs font-medium text-[#111315]">
                    {Math.round(activeJob.progress)}%
                  </span>
                  {isRunning && (
                    <button
                      onClick={() => onCancelJob(activeJob.job_id)}
                      className="px-2.5 py-1 rounded-md bg-white border border-[#FECACA] text-[#DC2626] hover:bg-[#FEF2F2] text-xs font-medium flex items-center gap-1 cursor-pointer"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      Hủy
                    </button>
                  )}
                  {activeJob.status === 'completed' && activeJob.audio_url && (
                    <button
                      onClick={() => onPlayTrack(activeJob)}
                      className="px-3 py-1 rounded-md btn-primary text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      Nghe bản thu
                    </button>
                  )}
                  {activeJob.chunks.length > 1 && (
                    <button
                      onClick={() => setShowChunks((v) => !v)}
                      className="p-1 text-[#717784] hover:text-[#111315] cursor-pointer"
                      title="Xem chi tiết từng đoạn"
                    >
                      {showChunks ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              <div className="w-full h-1.5 rounded-full bg-[#E5E7EB] overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    activeJob.status === 'error'
                      ? 'bg-[#DC2626]'
                      : activeJob.status === 'completed'
                        ? 'bg-[#15803D]'
                        : 'bg-[#111315]'
                  }`}
                  style={{ width: `${Math.max(3, activeJob.progress)}%` }}
                />
              </div>

              {showChunks && activeJob.chunks.length > 0 && (
                <div className="max-h-40 overflow-y-auto divide-y divide-[#ECEEF2] border border-[#E5E7EB] rounded-lg bg-white">
                  {activeJob.chunks.map((ch) => (
                    <div
                      key={ch.index}
                      className="px-3 py-1.5 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono-tech text-[11px] text-[#8C929D] shrink-0">
                          {String(ch.index + 1).padStart(2, '0')}
                        </span>
                        <span className="truncate text-[#3F444E]">{ch.text_preview}</span>
                      </div>
                      <span className="font-mono-tech text-[11px] text-[#717784] shrink-0">
                        {ch.status === 'done'
                          ? `${ch.duration_sec}s`
                          : ch.status === 'processing'
                            ? 'Đang tạo'
                            : ch.status === 'error'
                              ? 'Lỗi'
                              : 'Chờ'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* RIGHT INSPECTOR PANEL — Tactile Precision Settings */}
      <aside className="w-full xl:w-[372px] shrink-0 border-t xl:border-t-0 xl:border-l border-[#E5E7EB] bg-[#FAFAFB] flex flex-col justify-between">
        <div className="p-5 space-y-5 overflow-y-auto">
          {/* Segmented Switch: Stock AI vs Cloned Voices */}
          <div className="grid grid-cols-2 p-0.5 rounded-lg bg-[#EAECEF] border border-[#E2E4E9]">
            <button
              onClick={() => {
                setVoiceMode('stock');
                if (
                  engine === 'vizipvoice' ||
                  engine === 'zipvoice_gpu' ||
                  engine === 'f5_gpu' ||
                  engine === 'vieneu_gpu' ||
                  engine === 'hybrid_clone'
                ) {
                  setEngine('edge');
                }
              }}
              className={`py-1.5 rounded-md text-[13px] font-medium transition-all cursor-pointer ${
                voiceMode === 'stock'
                  ? 'bg-white text-[#111315] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-[#5C626E] hover:text-[#111315]'
              }`}
            >
              Giọng có sẵn
            </button>
            <button
              onClick={() => {
                setVoiceMode('cloned');
                const validCloneIds = availableCloneOptions.map((o) => o.id);
                if (!validCloneIds.includes(engine)) {
                  setEngine(defaultCloneEngine);
                }
                if (!selectedClonedId && clonedVoices[0]) onSelectClonedId(clonedVoices[0].id);
              }}
              className={`py-1.5 rounded-md text-[13px] font-medium transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                voiceMode === 'cloned'
                  ? 'bg-white text-[#111315] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-[#5C626E] hover:text-[#111315]'
              }`}
            >
              <span>Giọng Clone</span>
              <span className="font-mono-tech text-[11px] text-[#717784]">
                ({clonedVoices.length})
              </span>
            </button>
          </div>

          {/* Engine Selector (Clean, compact, zero hype cards) */}
          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-[#525866]">
              Bộ máy tổng hợp
            </label>
            {voiceMode === 'cloned' ? (
              <div
                className={`grid gap-1.5 ${
                  availableCloneOptions.length === 1
                    ? 'grid-cols-1'
                    : availableCloneOptions.length === 2
                      ? 'grid-cols-2'
                      : 'grid-cols-3'
                }`}
              >
                {availableCloneOptions.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => {
                      setEngine(opt.id);
                      setLocalError(null);
                    }}
                    className={`px-2.5 py-2 rounded-lg border text-left transition-colors cursor-pointer ${
                      engine === opt.id
                        ? 'bg-white border-[#111315] text-[#111315]'
                        : 'bg-white/60 border-[#E2E4E9] text-[#5C626E] hover:border-[#C4C9D1]'
                    }`}
                  >
                    <div className="text-[12px] font-semibold truncate">{opt.label}</div>
                    <div className="text-[10.5px] text-[#717784] truncate mt-0.5">{opt.sub}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div
                className={`grid gap-1.5 ${
                  availableStockOptions.length === 1 ? 'grid-cols-1' : 'grid-cols-3'
                }`}
              >
                {availableStockOptions.map((opt) => {
                  const active = engine === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => {
                        setEngine(opt.id);
                        setLocalError(null);
                      }}
                      className={`px-2.5 py-2 rounded-lg border text-left transition-colors cursor-pointer ${
                        active
                          ? 'bg-white border-[#111315] text-[#111315]'
                          : 'bg-white/60 border-[#E2E4E9] text-[#5C626E] hover:border-[#C4C9D1]'
                      }`}
                    >
                      <div className="text-[12px] font-semibold truncate">{opt.label}</div>
                      <div className="text-[10.5px] text-[#8C929D] truncate">{opt.sub}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* VOICE PICKER */}
          {voiceMode === 'cloned' ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-[12px] font-medium text-[#525866]">Chọn giọng Clone</label>
                <button
                  onClick={onGoToVault}
                  className="text-[12px] font-medium text-[#1D4ED8] hover:underline cursor-pointer"
                >
                  + Tạo giọng mới
                </button>
              </div>

              {clonedVoices.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#D1D5DB] bg-white p-5 text-center space-y-2.5">
                  <Fingerprint className="w-6 h-6 text-[#8C929D] mx-auto" />
                  <div className="text-[13px] font-medium text-[#111315]">
                    Chưa có giọng nào trong kho
                  </div>
                  <p className="text-xs text-[#717784] leading-relaxed">
                    Ghi âm hoặc tải lên một đoạn giọng 5–10 giây để nhân bản và đọc không giới hạn ký tự.
                  </p>
                  <button
                    onClick={onGoToVault}
                    className="px-3.5 py-1.5 rounded-lg btn-clone text-xs font-medium cursor-pointer"
                  >
                    Mở Kho giọng Clone
                  </button>
                </div>
              ) : (
                <div className="border border-[#E5E7EB] rounded-lg bg-white divide-y divide-[#F0F1F4] max-h-56 overflow-y-auto">
                  {clonedVoices.map((cv) => {
                    const selected = activeClonedProfile?.id === cv.id;
                    return (
                      <button
                        key={cv.id}
                        onClick={() => onSelectClonedId(cv.id)}
                        className={`w-full px-3 py-2.5 text-left flex items-center justify-between gap-2.5 transition-colors cursor-pointer ${
                          selected ? 'bg-[#EFF6FF]' : 'hover:bg-[#FAFAFB]'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-[#111315] truncate">
                            {cv.name}
                          </div>
                          <div className="text-[11px] font-mono-tech text-[#717784] mt-0.5">
                            {cv.duration_sec}s · {cv.pitch_hz} Hz · điểm {cv.quality_score}/100
                          </div>
                        </div>
                        {selected && <Check className="w-4 h-4 text-[#1D4ED8] shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {engine === 'hybrid_clone' && clonedVoices.length > 0 && (
                <div className="pt-1">
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-[#525866] font-medium">Độ bám âm sắc</span>
                    <span className="font-mono-tech text-[#111315]">
                      {Math.round(cloneStrength * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.25}
                    max={1.0}
                    step={0.05}
                    value={cloneStrength}
                    onChange={(e) => setCloneStrength(Number(e.target.value))}
                    className="w-full fader"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2.5">
              <label className="block text-[12px] font-medium text-[#525866]">Giọng đọc</label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#8C929D] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={voiceQuery}
                  onChange={(e) => setVoiceQuery(e.target.value)}
                  placeholder="Tìm tên giọng (Hoài My, Nam Minh, Minh Quân...)"
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white border border-[#DCDFE4] text-[12.5px] text-[#111315] placeholder-[#9CA3AF] focus:outline-none focus:border-[#111315]"
                />
              </div>

              {engine === 'edge' && (
                <div className="flex items-center gap-1 flex-wrap">
                  {[
                    { id: 'all', label: 'Tất cả' },
                    { id: 'vi', label: 'Tiếng Việt' },
                    { id: 'en', label: 'Tiếng Anh' },
                    { id: 'multi', label: 'Đa ngôn ngữ' },
                  ].map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setLangFilter(f.id as typeof langFilter)}
                      className={`px-2 py-1 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer ${
                        langFilter === f.id
                          ? 'bg-[#111315] text-white'
                          : 'bg-white border border-[#E2E4E9] text-[#5C626E] hover:text-[#111315]'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="border border-[#E5E7EB] rounded-lg bg-white divide-y divide-[#F2F3F5] max-h-56 overflow-y-auto">
                {filteredStockVoices.slice(0, 60).map((v) => {
                  const active = (selectedStockVoice[engine] || '') === v.id;
                  return (
                    <button
                      key={v.id}
                      onClick={() =>
                        setSelectedStockVoice((prev) => ({ ...prev, [engine]: v.id }))
                      }
                      className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                        active ? 'bg-[#F3F4F6]' : 'hover:bg-[#FAFAFB]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-[#111315] truncate">
                          {v.short_name}
                        </div>
                        <div className="text-[11px] text-[#717784] truncate">{v.name}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[11px] text-[#8C929D]">
                          {v.gender === 'Female' ? 'Nữ' : 'Nam'}
                        </span>
                        {active && <Check className="w-3.5 h-3.5 text-[#111315]" />}
                      </div>
                    </button>
                  );
                })}
              </div>

              {engine === 'kokoro' && (
                <div className="p-3 rounded-lg bg-white border border-[#E5E7EB] space-y-2.5">
                  <label className="flex items-center justify-between text-xs font-medium text-[#111315] cursor-pointer">
                    <span>Trộn 2 giọng (Voice Blending)</span>
                    <input
                      type="checkbox"
                      checked={blendEnabled}
                      onChange={(e) => setBlendEnabled(e.target.checked)}
                      className="accent-[#111315] w-3.5 h-3.5"
                    />
                  </label>
                  {blendEnabled && (
                    <div className="space-y-2 pt-1">
                      <select
                        value={blendVoiceId}
                        onChange={(e) => setBlendVoiceId(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-md bg-[#FAFAFB] border border-[#DCDFE4] text-xs text-[#111315]"
                      >
                        {currentStockVoices.map((v) => (
                          <option key={v.id} value={v.id}>
                            Giọng B: {v.name}
                          </option>
                        ))}
                      </select>
                      <div>
                        <div className="flex justify-between text-[11px] font-mono-tech text-[#5C626E] mb-1">
                          <span>Giọng A: {Math.round(blendRatio * 100)}%</span>
                          <span>Giọng B: {Math.round((1 - blendRatio) * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min={0.1}
                          max={0.9}
                          step={0.05}
                          value={blendRatio}
                          onChange={(e) => setBlendRatio(Number(e.target.value))}
                          className="w-full fader"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Sliders */}
          <div className="pt-4 border-t border-[#E5E7EB] space-y-4">
            {(engine === 'vieneu' || engine === 'vizipvoice') && (
              <div className="space-y-1.5">
                <label className="block text-[12px] font-medium text-[#525866]">
                  Tốc độ xử lý AI
                </label>
                <div className="grid grid-cols-3 gap-1">
                  {[
                    { id: 'turbo', label: 'Siêu nhanh' },
                    { id: 'balanced', label: 'Cân bằng' },
                    { id: 'high', label: 'Kỹ nhất' },
                  ].map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setQualityMode(m.id as 'turbo' | 'balanced' | 'high')}
                      className={`py-1.5 rounded-md text-[11.5px] font-medium border transition-colors cursor-pointer ${
                        qualityMode === m.id
                          ? 'bg-[#111315] text-white border-[#111315]'
                          : 'bg-white text-[#525866] border-[#DCDFE4] hover:border-[#B8BEC9]'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#525866] font-medium">Tốc độ đọc</span>
                <span className="font-mono-tech text-[#111315]">{speed.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min={0.6}
                max={1.7}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-full fader"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#525866] font-medium">Khoảng nghỉ giữa câu</span>
                <span className="font-mono-tech text-[#111315]">{pauseMs} ms</span>
              </div>
              <input
                type="range"
                min={0}
                max={900}
                step={40}
                value={pauseMs}
                onChange={(e) => setPauseMs(Number(e.target.value))}
                className="w-full fader"
              />
            </div>

            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between text-xs font-medium text-[#525866] hover:text-[#111315] cursor-pointer"
            >
              <span>Tùy chọn xuất &amp; âm học</span>
              {showAdvanced ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>

            {showAdvanced && (
              <div className="p-3 rounded-lg bg-white border border-[#E5E7EB] space-y-3">
                {(engine === 'edge' || engine === 'hybrid_clone') && (
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-[#525866]">Cao độ (Pitch)</span>
                      <span className="font-mono-tech text-[#111315]">
                        {pitch > 0 ? `+${pitch}` : pitch}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-16}
                      max={16}
                      step={1}
                      value={pitch}
                      onChange={(e) => setPitch(Number(e.target.value))}
                      className="w-full fader"
                    />
                  </div>
                )}

                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525866]">Định dạng tệp</span>
                  <div className="flex gap-1">
                    {(['mp3', 'wav'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        onClick={() => setOutputFormat(fmt)}
                        className={`px-2.5 py-1 rounded-md font-mono-tech uppercase text-[11px] border cursor-pointer ${
                          outputFormat === fmt
                            ? 'bg-[#111315] text-white border-[#111315]'
                            : 'bg-white text-[#525866] border-[#DCDFE4]'
                        }`}
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center justify-between text-xs text-[#3F444E] cursor-pointer">
                  <span>Cân bằng âm lượng (-16 LUFS)</span>
                  <input
                    type="checkbox"
                    checked={normalizeAudio}
                    onChange={(e) => setNormalizeAudio(e.target.checked)}
                    className="accent-[#111315] w-3.5 h-3.5"
                  />
                </label>

                <label className="flex items-center justify-between text-xs text-[#3F444E] cursor-pointer">
                  <span>Xuất phụ đề SRT &amp; VTT</span>
                  <input
                    type="checkbox"
                    checked={generateSubtitles}
                    onChange={(e) => setGenerateSubtitles(e.target.checked)}
                    className="accent-[#111315] w-3.5 h-3.5"
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Sticky Primary Action Footer */}
        <div className="p-5 border-t border-[#E5E7EB] bg-white">
          <button
            onClick={handleForge}
            disabled={submitting || Boolean(isRunning) || !text.trim()}
            className="w-full py-2.5 px-4 rounded-lg btn-primary text-[13.5px] font-semibold flex items-center justify-center gap-2 disabled:cursor-not-allowed cursor-pointer"
          >
            {submitting || isRunning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Đang tạo giọng nói...</span>
              </>
            ) : (
              <span>
                {voiceMode === 'cloned' ? 'Đọc bằng giọng Clone' : 'Tạo giọng nói'}
              </span>
            )}
          </button>
        </div>
      </aside>
    </div>
  );
};
