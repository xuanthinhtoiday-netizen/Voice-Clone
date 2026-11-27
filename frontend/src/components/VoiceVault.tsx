import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Fingerprint,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../api';
import type { ClonedVoiceProfile } from '../types';

interface VoiceVaultProps {
  clonedVoices: ClonedVoiceProfile[];
  onVoicesChanged: () => Promise<void>;
  onUseVoiceInStudio: (voiceId: string) => void;
}

const CALIBRATION_SCRIPTS = [
  'Xin chào, hôm nay trời thật đẹp và trong lành. Đây là giọng nói tự nhiên của tôi được thu âm để nhân bản trên phòng thu VoxForge.',
  'Giữa nhịp sống hiện đại, một giọng nói ấm áp và rõ ràng luôn tạo ra cảm giác gần gũi và tin cậy cho người nghe.',
  'Khi đọc với tốc độ vừa phải ở nơi yên tĩnh, hệ thống sẽ ghi nhận chính xác âm sắc và nhịp điệu giọng nói của bạn.',
];

export const VoiceVault: React.FC<VoiceVaultProps> = ({
  clonedVoices,
  onVoicesChanged,
  onUseVoiceInStudio,
}) => {
  const [sourceMode, setSourceMode] = useState<'mic' | 'upload'>('mic');
  const [scriptIdx, setScriptIdx] = useState(0);

  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const meterRafRef = useRef<number | null>(null);

  const [sampleFile, setSampleFile] = useState<File | null>(null);
  const [samplePreviewUrl, setSamplePreviewUrl] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [language, setLanguage] = useState('vi');
  const [gender, setGender] = useState('neutral');
  const [description, setDescription] = useState('');
  const [refText, setRefText] = useState('');
  const [tags, setTags] = useState('Tự nhiên');
  const [denoise, setDenoise] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      stopMicCleanup();
      if (samplePreviewUrl) URL.revokeObjectURL(samplePreviewUrl);
    };
  }, []);

  const stopMicCleanup = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (meterRafRef.current) cancelAnimationFrame(meterRafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setMicLevel(0);
  };

  const startRecording = async () => {
    setError(null);
    setSuccessMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tickMeter = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setMicLevel(Math.min(1, avg / 90));
        meterRafRef.current = requestAnimationFrame(tickMeter);
      };
      meterRafRef.current = requestAnimationFrame(tickMeter);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const file = new File([blob], `mic_clone_${Date.now()}.webm`, { type: mimeType });
        setSampleFile(file);
        if (samplePreviewUrl) URL.revokeObjectURL(samplePreviewUrl);
        setSamplePreviewUrl(URL.createObjectURL(blob));
        stopMicCleanup();
        ctx.close().catch(() => {});
      };

      mr.start(150);
      setRecording(true);
      setRecordSeconds(0);
      const started = Date.now();
      timerRef.current = window.setInterval(() => {
        setRecordSeconds((Date.now() - started) / 1000);
      }, 100);
    } catch {
      setError('Không thể truy cập micro. Hãy cấp quyền micro trên trình duyệt hoặc chọn tải tệp âm thanh.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setSuccessMsg(null);
    setSampleFile(file);
    if (samplePreviewUrl) URL.revokeObjectURL(samplePreviewUrl);
    setSamplePreviewUrl(URL.createObjectURL(file));
    if (!name) {
      setName(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
    }
  };

  const handleSaveClone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sampleFile) {
      setError('Hãy ghi âm hoặc chọn một tệp âm thanh mẫu (4–15 giây) trước.');
      return;
    }
    setUploading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', sampleFile);
      fd.append('name', name.trim() || `Giọng Clone #${clonedVoices.length + 1}`);
      fd.append('language', language);
      fd.append('gender', gender);
      fd.append('description', description);
      fd.append('tags', tags);
      fd.append('ref_text', refText.trim() || (sourceMode === 'mic' ? CALIBRATION_SCRIPTS[scriptIdx] : ''));
      fd.append('denoise', String(denoise));

      const created = await api.createClonedVoice(fd);
      await onVoicesChanged();
      setSuccessMsg(`Đã lưu giọng "${created.name}" (${created.duration_sec}s · chất lượng ${created.quality_score}/100).`);
      setName('');
      setDescription('');
      setRefText('');
      setSampleFile(null);
      if (samplePreviewUrl) {
        URL.revokeObjectURL(samplePreviewUrl);
        setSamplePreviewUrl(null);
      }
      setRecordSeconds(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không xử lý được tệp mẫu giọng nói.');
    } finally {
      setUploading(false);
    }
  };

  const togglePlaySample = (voice: ClonedVoiceProfile) => {
    if (!previewAudioRef.current) {
      previewAudioRef.current = new Audio();
      previewAudioRef.current.onended = () => setPlayingVoiceId(null);
    }
    const audio = previewAudioRef.current;
    if (playingVoiceId === voice.id) {
      audio.pause();
      setPlayingVoiceId(null);
    } else {
      audio.src = voice.audio_url;
      audio.play().catch(() => {});
      setPlayingVoiceId(voice.id);
    }
  };

  const handleDelete = async (voiceId: string) => {
    await api.deleteClonedVoice(voiceId);
    await onVoicesChanged();
  };

  return (
    <div className="max-w-5xl mx-auto px-6 lg:px-10 py-8 pb-32 space-y-8">
      {/* Clean Page Header */}
      <div className="border-b border-[#E5E7EB] pb-5">
        <h1 className="text-[22px] font-bold tracking-[-0.02em] text-[#111315]">
          Kho giọng Clone
        </h1>
        <p className="text-[14px] text-[#5C626E] mt-1 max-w-2xl">
          Thu âm trực tiếp hoặc tải lên một đoạn giọng sạch dài 5 đến 12 giây. Hệ thống tự động khử nhiễu, phân tích cao độ và lưu thành hồ sơ giọng để dùng đọc văn bản không giới hạn ký tự.
        </p>
      </div>

      {/* Creation Split Panel */}
      <div className="panel rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12">
        {/* Left: Studio Capture Booth */}
        <div className="lg:col-span-6 p-6 bg-[#FAFAFB] border-b lg:border-b-0 lg:border-r border-[#E5E7EB] space-y-5">
          <div className="grid grid-cols-2 p-0.5 rounded-lg bg-[#EAECEF] border border-[#E2E4E9]">
            <button
              type="button"
              onClick={() => setSourceMode('mic')}
              className={`py-1.5 rounded-md text-[13px] font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                sourceMode === 'mic'
                  ? 'bg-white text-[#111315] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-[#5C626E] hover:text-[#111315]'
              }`}
            >
              <Mic className="w-3.5 h-3.5" />
              Ghi âm từ micro
            </button>
            <button
              type="button"
              onClick={() => setSourceMode('upload')}
              className={`py-1.5 rounded-md text-[13px] font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                sourceMode === 'upload'
                  ? 'bg-white text-[#111315] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-[#5C626E] hover:text-[#111315]'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              Tải tệp âm thanh
            </button>
          </div>

          {sourceMode === 'mic' ? (
            <div className="space-y-5">
              {/* Quiet Teleprompter Box */}
              <div className="p-4 rounded-lg bg-white border border-[#E5E7EB]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-medium text-[#717784]">
                    Câu mẫu gợi ý (đọc tự nhiên 5–10 giây)
                  </span>
                  <button
                    type="button"
                    onClick={() => setScriptIdx((i) => (i + 1) % CALIBRATION_SCRIPTS.length)}
                    className="text-[12px] text-[#525866] hover:text-[#111315] flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Câu khác
                  </button>
                </div>
                <p className="text-[14px] text-[#111315] leading-relaxed">
                  “{CALIBRATION_SCRIPTS[scriptIdx]}”
                </p>
              </div>

              {/* Tactile Physical REC Control (Tape Deck inspired) */}
              <div className="flex flex-col items-center py-3 space-y-4">
                <div className="relative">
                  {recording && (
                    <span
                      className="absolute inset-0 rounded-full bg-[#DC2626]/20 animate-rec-ripple"
                      style={{ transform: `scale(${1 + micLevel * 0.4})` }}
                    />
                  )}
                  <button
                    type="button"
                    onClick={recording ? stopRecording : startRecording}
                    className={`relative w-16 h-16 rounded-full flex items-center justify-center transition-all cursor-pointer border-4 border-white shadow-[0_2px_10px_rgba(0,0,0,0.14)] ${
                      recording
                        ? 'bg-[#DC2626] text-white scale-105'
                        : 'bg-[#111315] text-white hover:bg-[#DC2626]'
                    }`}
                    title={recording ? 'Dừng ghi âm' : 'Bắt đầu ghi âm'}
                  >
                    {recording ? (
                      <Square className="w-5 h-5 fill-current" />
                    ) : (
                      <Mic className="w-6 h-6" />
                    )}
                  </button>
                </div>

                <div className="w-full max-w-[260px] text-center space-y-2">
                  <div className="font-mono-tech text-[15px] font-semibold text-[#111315]">
                    {recordSeconds.toFixed(1)}s{' '}
                    <span className="text-[12px] font-normal text-[#8C929D]">/ 5–12s chuẩn</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-[#E5E7EB] overflow-hidden">
                    <div
                      className={`h-full transition-all duration-100 ${
                        recordSeconds >= 4 && recordSeconds <= 15
                          ? 'bg-[#15803D]'
                          : recordSeconds > 15
                            ? 'bg-[#D97706]'
                            : 'bg-[#111315]'
                      }`}
                      style={{ width: `${Math.min(100, (recordSeconds / 15) * 100)}%` }}
                    />
                  </div>
                  <p className="text-[12px] text-[#717784]">
                    {recording ? 'Đang thu âm — nhấn nút đỏ để dừng.' : 'Nhấn nút để bắt đầu thu mẫu.'}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <label className="rounded-xl border border-dashed border-[#C4C9D1] hover:border-[#111315] bg-white p-8 flex flex-col items-center justify-center text-center space-y-2.5 cursor-pointer transition-colors min-h-[240px]">
              <Upload className="w-6 h-6 text-[#525866]" />
              <div className="text-[13.5px] font-semibold text-[#111315]">
                Chọn hoặc kéo thả tệp âm thanh vào đây
              </div>
              <p className="text-xs text-[#717784] max-w-xs leading-relaxed">
                Hỗ trợ WAV, MP3, M4A, OGG, WebM, FLAC. Tốt nhất là giọng nói rõ ràng, ít tạp âm nền, dài 4–15 giây.
              </p>
              {sampleFile && (
                <div className="mt-2 px-3 py-1 rounded-md bg-[#F0FDF4] border border-[#BBF7D0] text-[#15803D] text-xs font-mono-tech">
                  {sampleFile.name} ({(sampleFile.size / 1024).toFixed(0)} KB)
                </div>
              )}
              <input
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
          )}

          {samplePreviewUrl && (
            <div className="p-2.5 rounded-lg bg-white border border-[#E5E7EB]">
              <audio src={samplePreviewUrl} controls className="w-full h-8" />
            </div>
          )}
        </div>

        {/* Right: Metadata Form */}
        <form onSubmit={handleSaveClone} className="lg:col-span-6 p-6 bg-white flex flex-col justify-between space-y-5">
          <div className="space-y-4">
            <div>
              <label className="block text-[12.5px] font-medium text-[#3F444E] mb-1.5">
                Tên giọng nói
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ví dụ: Giọng của tôi, MC Review..."
                className="w-full px-3 py-2 rounded-lg bg-white border border-[#DCDFE4] text-[13.5px] text-[#111315] placeholder-[#9CA3AF] focus:outline-none focus:border-[#111315]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[12.5px] font-medium text-[#3F444E] mb-1.5">
                  Ngôn ngữ chính
                </label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-[#DCDFE4] text-[13.5px] text-[#111315] focus:outline-none focus:border-[#111315]"
                >
                  <option value="vi">Tiếng Việt</option>
                  <option value="en">Tiếng Anh</option>
                  <option value="vi-en">Song ngữ Việt – Anh</option>
                </select>
              </div>
              <div>
                <label className="block text-[12.5px] font-medium text-[#3F444E] mb-1.5">
                  Tông giọng
                </label>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-[#DCDFE4] text-[13.5px] text-[#111315] focus:outline-none focus:border-[#111315]"
                >
                  <option value="male">Nam</option>
                  <option value="female">Nữ</option>
                  <option value="neutral">Tự động nhận diện</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-[#3F444E] mb-1.5">
                Lời thoại 5 giây đầu trong mẫu (tùy chọn — để trống sẽ tự nhận diện)
              </label>
              <textarea
                rows={2}
                value={refText}
                onChange={(e) => setRefText(e.target.value)}
                placeholder="Gõ đúng câu nói đầu tiên trong file audio giúp ViZipVoice nhân bản giống gần như 100%..."
                className="w-full px-3 py-2 rounded-lg bg-white border border-[#DCDFE4] text-[13px] text-[#111315] placeholder-[#9CA3AF] focus:outline-none focus:border-[#111315] resize-none"
              />
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-[#3F444E] mb-1.5">
                Thẻ phân loại (phân cách bằng dấu phẩy)
              </label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="Podcast, Đọc truyện, Thuyết minh"
                className="w-full px-3 py-2 rounded-lg bg-white border border-[#DCDFE4] text-[13.5px] text-[#111315] placeholder-[#9CA3AF] focus:outline-none focus:border-[#111315]"
              />
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-[#3F444E] mb-1.5">
                Ghi chú (tùy chọn)
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ghi chú về điều kiện thu hoặc phong cách đọc"
                className="w-full px-3 py-2 rounded-lg bg-white border border-[#DCDFE4] text-[13.5px] text-[#111315] placeholder-[#9CA3AF] focus:outline-none focus:border-[#111315]"
              />
            </div>

            <label className="flex items-center justify-between p-3 rounded-lg bg-[#FAFAFB] border border-[#E5E7EB] cursor-pointer">
              <div>
                <div className="text-[12.5px] font-medium text-[#111315]">
                  Lọc nhiễu nền (chỉ bật nếu file thu có tiếng quạt/ồn)
                </div>
                <div className="text-[11.5px] text-[#717784]">
                  Nên tắt với file âm thanh sạch để giữ nguyên 100% âm sắc gốc
                </div>
              </div>
              <input
                type="checkbox"
                checked={denoise}
                onChange={(e) => setDenoise(e.target.checked)}
                className="accent-[#111315] w-4 h-4 shrink-0"
              />
            </label>
          </div>

          <div className="space-y-3">
            {error && (
              <div className="p-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-[#991B1B] text-xs">
                {error}
              </div>
            )}
            {successMsg && (
              <div className="p-3 rounded-lg bg-[#F0FDF4] border border-[#BBF7D0] text-[#166534] text-xs flex items-center gap-2">
                <Check className="w-4 h-4 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={uploading || !sampleFile}
              className="w-full py-2.5 px-4 rounded-lg btn-primary text-[13.5px] font-semibold flex items-center justify-center gap-2 disabled:cursor-not-allowed cursor-pointer"
            >
              {uploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Đang phân tích và lưu giọng...</span>
                </>
              ) : (
                <span>Lưu vào Kho giọng Clone</span>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Saved Cloned Voices */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[#111315]">
            Giọng đã lưu{' '}
            <span className="font-mono-tech text-[#8C929D] font-normal ml-1">
              ({clonedVoices.length})
            </span>
          </h2>
        </div>

        {clonedVoices.length === 0 ? (
          <div className="panel rounded-xl p-10 text-center space-y-1.5">
            <Fingerprint className="w-7 h-7 text-[#9CA3AF] mx-auto mb-2" />
            <div className="text-[14px] font-medium text-[#111315]">Chưa có giọng clone nào</div>
            <p className="text-xs text-[#717784]">
              Thu âm 5–10 giây hoặc tải một tệp giọng nói ở khung phía trên để tạo hồ sơ đầu tiên.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {clonedVoices.map((voice) => {
              const playing = playingVoiceId === voice.id;
              return (
                <div
                  key={voice.id}
                  className="panel rounded-xl p-4 flex flex-col justify-between gap-4 hover:border-[#C4C9D1] transition-colors"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-[14.5px] font-semibold text-[#111315] truncate">
                          {voice.name}
                        </h3>
                        <p className="text-xs text-[#717784] truncate mt-0.5">
                          {voice.quality_note || 'Sẵn sàng nhân bản'}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDelete(voice.id)}
                        className="p-1.5 rounded-md text-[#8C929D] hover:text-[#DC2626] hover:bg-[#FEF2F2] transition-colors cursor-pointer"
                        title="Xóa giọng này"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Clean Ink Waveform Strip */}
                    <div className="h-10 rounded-lg bg-[#FAFAFB] border border-[#ECEEF2] px-2.5 flex items-center gap-[2px] overflow-hidden">
                      {(voice.waveform_peaks.length
                        ? voice.waveform_peaks.slice(0, 64)
                        : Array(48).fill(0.35)
                      ).map((p, idx) => (
                        <span
                          key={idx}
                          className={`flex-1 rounded-full ${
                            playing ? 'bg-[#1D4ED8] animate-pulse' : 'bg-[#111315]/70'
                          }`}
                          style={{ height: `${Math.max(14, Math.round(p * 100))}%` }}
                        />
                      ))}
                    </div>

                    <div className="flex items-center flex-wrap gap-2 text-[11.5px] font-mono-tech text-[#5C626E]">
                      <span className="px-2 py-0.5 rounded bg-[#F0FDF4] text-[#15803D] border border-[#DCFCE7]">
                        Chất lượng {voice.quality_score}/100
                      </span>
                      <span>{voice.duration_sec}s</span>
                      <span>·</span>
                      <span>F0 {voice.pitch_hz} Hz</span>
                      {voice.tags.slice(0, 2).map((t) => (
                        <span
                          key={t}
                          className="font-sans px-2 py-0.5 rounded bg-[#F3F4F6] text-[#525866]"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-3 border-t border-[#ECEEF2]">
                    <button
                      onClick={() => togglePlaySample(voice)}
                      className="px-3 py-1.5 rounded-lg btn-secondary text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                    >
                      {playing ? (
                        <Pause className="w-3.5 h-3.5" />
                      ) : (
                        <Play className="w-3.5 h-3.5" />
                      )}
                      <span>Nghe mẫu</span>
                    </button>
                    <button
                      onClick={() => onUseVoiceInStudio(voice.id)}
                      className="flex-1 py-1.5 px-3 rounded-lg btn-primary text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <span>Dùng giọng này để đọc</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
