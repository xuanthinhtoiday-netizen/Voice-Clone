import React, { useEffect, useState } from 'react';
import { Check, Download, KeyRound, Loader2 } from 'lucide-react';
import { api } from '../api';
import type { EngineStatus } from '../types';

interface EngineHubProps {
  engines: EngineStatus[];
  ffmpegReady: boolean;
  onRefreshEngines: () => Promise<void>;
}

const REPO_SOURCES = [
  {
    repo: 'pnnbao97/VieNeu-TTS',
    role: 'Nhân bản giọng tiếng Việt Zero-Shot (ONNX CPU)',
    detail:
      'Chỉ cần 4–12 giây mẫu, không yêu cầu GPU rời. Tự động lưu cache Speaker Embedding để đọc văn bản không giới hạn nhanh và ổn định.',
  },
  {
    repo: 'rany2/edge-tts',
    role: 'Giọng đọc Neural đa ngôn ngữ & phụ đề SRT',
    detail:
      'Hơn 300 giọng đọc chuẩn phòng thu (Hoài My, Nam Minh, Multilingual), tốc độ cao và hỗ trợ mốc thời gian từng từ cho phụ đề.',
  },
  {
    repo: 'hexgrad/kokoro',
    role: 'Mô hình 82M offline CPU & trộn giọng (Voice Blending)',
    detail:
      'Chạy gọn nhẹ trên CPU thông thường, cho phép pha trộn tỷ lệ hai giọng nói để tạo ra chất giọng mới.',
  },
  {
    repo: 'F5-TTS & Chatterbox Pipeline',
    role: 'Xử lý không giới hạn ký tự & chuẩn hóa âm thanh',
    detail:
      'Tự động tách câu giữ nhịp đoạn văn, lọc nhiễu nền mẫu clone, ghép nối Cosine Crossfade và cân bằng âm lượng -16 LUFS.',
  },
];

export const EngineHub: React.FC<EngineHubProps> = ({
  engines,
  ffmpegReady,
  onRefreshEngines,
}) => {
  const [triggering, setTriggering] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hfTokenInput, setHfTokenInput] = useState('');
  const [hfStatus, setHfStatus] = useState<{ has_hf_token: boolean; hf_token_masked: string }>({
    has_hf_token: false,
    hf_token_masked: '',
  });
  const [savingToken, setSavingToken] = useState(false);
  const [runtime, setRuntime] = useState<'cloudflare-hono' | 'python-local'>('python-local');

  useEffect(() => {
    api
      .getRuntime()
      .then(setRuntime)
      .catch(() => {});
    api
      .getSettings()
      .then(setHfStatus)
      .catch(() => {});
  }, []);

  const handleSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingToken(true);
    try {
      const res = await api.saveSettings(hfTokenInput);
      setHfStatus(res);
      setHfTokenInput('');
      setNotice(
        res.has_hf_token
          ? 'Đã lưu Hugging Face Token — chế độ ZipVoice GPU sẽ chạy nhanh trên NVIDIA A10G.'
          : 'Đã xóa Hugging Face Token.'
      );
      await onRefreshEngines();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Không lưu được token.');
    } finally {
      setSavingToken(false);
    }
  };

  const handlePrepare = async (engineId: string) => {
    setTriggering(engineId);
    setNotice(null);
    try {
      const res = await api.prepareEngine(engineId);
      setNotice(res.message || `Đang chuẩn bị ${engineId}...`);
      await onRefreshEngines();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Không thể chuẩn bị mô hình.');
    } finally {
      setTriggering(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-6 lg:px-10 py-8 pb-32 space-y-8">
      <div className="border-b border-[#E5E7EB] pb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-[#111315]">
            Mô hình AI &amp; Nguồn mở
          </h1>
          <p className="text-[14px] text-[#5C626E] mt-1">
            Quản lý các bộ máy tổng hợp giọng nói đang chạy cục bộ và trên đám mây.
          </p>
        </div>
        <span className="text-xs font-mono-tech text-[#5C626E]">
          {runtime === 'cloudflare-hono'
            ? 'Backend: Cloudflare Workers · Hono.js'
            : `FFmpeg encoder: ${ffmpegReady ? 'Sẵn sàng' : 'Chế độ WAV'}`}
        </span>
      </div>

      {notice && (
        <div className="p-3.5 rounded-lg bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E40AF] text-xs flex items-center justify-between gap-3">
          <span>{notice}</span>
          <button onClick={() => onRefreshEngines()} className="font-semibold underline cursor-pointer">
            Làm mới
          </button>
        </div>
      )}

      {/* Engines List */}
      <div className="panel rounded-xl divide-y divide-[#ECEEF2] overflow-hidden">
        {engines.map((eng) => {
          const busy = Boolean(eng.downloading || eng.loading || triggering === eng.id);
          const needsDownload =
            (eng.id === 'kokoro' && !eng.downloaded) || (eng.id === 'vieneu' && !eng.loaded);

          return (
            <div key={eng.id} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1.5 flex-1 min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      busy
                        ? 'bg-[#D97706] animate-pulse'
                        : eng.ready
                          ? 'bg-[#15803D]'
                          : 'bg-[#C4C9D1]'
                    }`}
                  />
                  <h2 className="text-[14.5px] font-semibold text-[#111315]">{eng.name}</h2>
                  <span className="font-mono-tech text-[11.5px] text-[#717784]">
                    {eng.source_repo}
                  </span>
                </div>

                <p className="text-[13px] text-[#5C626E] leading-relaxed max-w-2xl">
                  {eng.description}
                </p>

                <div className="flex items-center gap-3 text-[11.5px] font-mono-tech text-[#8C929D] pt-0.5 flex-wrap">
                  <span>Phân đoạn: {eng.max_chunk_chars} ký tự</span>
                  {eng.supports_cloning && (
                    <span className="text-[#1D4ED8] font-medium">Hỗ trợ Clone giọng</span>
                  )}
                  {eng.supports_blending && (
                    <span className="text-[#111315] font-medium">Hỗ trợ Trộn 2 giọng</span>
                  )}
                </div>

                {(eng.downloading || eng.loading) && (
                  <div className="pt-2 max-w-md space-y-1">
                    <div className="flex justify-between text-xs text-[#525866]">
                      <span>{eng.download_stage || 'Đang tải trọng số...'}</span>
                      {eng.download_progress !== undefined && (
                        <span className="font-mono-tech">{Math.round(eng.download_progress)}%</span>
                      )}
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-[#E5E7EB] overflow-hidden">
                      <div
                        className="h-full bg-[#111315] transition-all"
                        style={{ width: `${Math.max(10, eng.download_progress || 40)}%` }}
                      />
                    </div>
                  </div>
                )}

                {eng.last_error && (
                  <div className="text-xs text-[#DC2626] mt-1">{eng.last_error}</div>
                )}
              </div>

              <div className="shrink-0">
                {needsDownload ? (
                  <button
                    onClick={() => handlePrepare(eng.id)}
                    disabled={busy}
                    className="px-3.5 py-2 rounded-lg btn-secondary text-xs font-medium flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    {busy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    <span>{eng.id === 'kokoro' ? 'Tải mô hình (~320 MB)' : 'Nạp trước mô hình'}</span>
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#15803D]">
                    <Check className="w-4 h-4" />
                    Sẵn sàng
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Optional Hugging Face Token for Free NVIDIA A10G GPU Speed */}
      <form onSubmit={handleSaveToken} className="panel rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[#111315]" />
            <h2 className="text-[14px] font-semibold text-[#111315]">
              Hugging Face Token (tùy chọn — tăng tốc Clone trên GPU Cloud)
            </h2>
          </div>
          <span className="text-xs font-mono-tech text-[#5C626E]">
            {hfStatus.has_hf_token
              ? `Đang dùng: ${hfStatus.hf_token_masked}`
              : runtime === 'cloudflare-hono'
                ? 'Chưa cấu hình (dùng quota miễn phí)'
                : 'Chưa cấu hình (chạy Offline CPU)'}
          </span>
        </div>
        <p className="text-xs text-[#717784] leading-relaxed">
          {runtime === 'cloudflare-hono'
            ? 'Trên Cloudflare Workers (Hono.js), giọng Clone chạy trên NVIDIA A10G GPU Cloud. Dán mã Hugging Face Token (Read) miễn phí từ huggingface.co/settings/tokens để tránh hết lượt GPU chung (token lưu ngay trên trình duyệt của bạn, hoặc cấu hình sẵn qua biến mật HF_TOKEN trên Cloudflare).'
            : 'ViZipVoice 7000h đã chạy 100% offline trên máy bạn. Nếu muốn tăng tốc lên 2–4 giây/đoạn bằng NVIDIA A10G GPU miễn phí, dán mã token (Read) từ huggingface.co/settings/tokens vào đây.'}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={hfTokenInput}
            onChange={(e) => setHfTokenInput(e.target.value)}
            placeholder="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            className="flex-1 px-3 py-2 rounded-lg bg-white border border-[#DCDFE4] text-xs font-mono-tech text-[#111315] placeholder-[#9CA3AF] focus:outline-none focus:border-[#111315]"
          />
          <button
            type="submit"
            disabled={savingToken}
            className="px-4 py-2 rounded-lg btn-primary text-xs font-medium cursor-pointer shrink-0"
          >
            {savingToken ? 'Đang lưu...' : 'Lưu Token'}
          </button>
        </div>
      </form>

      {/* Open Source Architecture Breakdown */}
      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold text-[#111315]">
          Các kho mã nguồn mở được kết hợp
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {REPO_SOURCES.map((item) => (
            <div key={item.repo} className="panel rounded-xl p-4 space-y-1.5">
              <div className="font-mono-tech text-xs font-semibold text-[#111315]">
                {item.repo}
              </div>
              <div className="text-[13px] font-medium text-[#3F444E]">{item.role}</div>
              <p className="text-xs text-[#717784] leading-relaxed">{item.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
