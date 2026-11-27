import React, { useEffect, useState } from 'react';
import { Check, Cpu, Download, ExternalLink, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { EngineStatus } from '../types';

const COLAB_NOTEBOOK_URL =
  'https://colab.research.google.com/github/xuanthinhtoiday-netizen/Voice-Clone/blob/main/colab/F5_TTS_Viet_6000h_Server.ipynb';

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
  const [f5UrlInput, setF5UrlInput] = useState('');
  const [savedF5Url, setSavedF5Url] = useState('');
  const [gpuHealth, setGpuHealth] = useState<{
    ok: boolean;
    gpu?: string;
    model?: string;
    error?: string;
  } | null>(null);
  const [testingGpu, setTestingGpu] = useState(false);

  useEffect(() => {
    api
      .getRuntime()
      .then(setRuntime)
      .catch(() => {});
    api
      .getSettings()
      .then(setHfStatus)
      .catch(() => {});
    const existingUrl = api.getF5ServerUrl();
    if (existingUrl) {
      setF5UrlInput(existingUrl);
      setSavedF5Url(existingUrl);
    }
  }, []);

  const handleSaveF5Server = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = api.saveF5ServerUrl(f5UrlInput);
    setSavedF5Url(cleaned);
    setF5UrlInput(cleaned);
    setGpuHealth(null);
    setNotice(null);

    if (!cleaned) {
      setNotice('Đã ngắt kết nối Colab GPU Server (chuyển về Space công cộng).');
      await onRefreshEngines();
      return;
    }

    setTestingGpu(true);
    try {
      const res = await api.testF5Server(cleaned);
      setGpuHealth(res);
      if (res.ok) {
        setNotice(
          `Đã kết nối thành công ${res.gpu || 'GPU'} (${res.model || 'F5-TTS Việt 6000h'}) — sẵn sàng đọc không giới hạn ký tự!`
        );
      } else {
        setNotice(res.error || 'Chưa kết nối được tới link Colab GPU.');
      }
      await onRefreshEngines();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không kiểm tra được kết nối GPU.';
      setGpuHealth({ ok: false, error: msg });
      setNotice(msg);
    } finally {
      setTestingGpu(false);
    }
  };

  const handleClearF5Server = async () => {
    api.saveF5ServerUrl('');
    setF5UrlInput('');
    setSavedF5Url('');
    setGpuHealth(null);
    setNotice('Đã xóa link Colab GPU Server.');
    await onRefreshEngines();
  };

  const handleSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingToken(true);
    try {
      const res = await api.saveSettings(hfTokenInput);
      setHfStatus(res);
      setHfTokenInput('');
      setNotice(
        res.has_hf_token
          ? 'Đã lưu Hugging Face Token — chế độ F5-TTS Việt 6000h sẽ chạy nhanh và ổn định trên GPU Cloud.'
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

      {/* Dedicated Google Colab / Kaggle T4 GPU Server (Unlimited, Free, Zero Quota) */}
      {runtime === 'cloudflare-hono' && (
        <form onSubmit={handleSaveF5Server} className="panel rounded-xl p-5 space-y-3.5 border-[#111315]/15">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#111315]" />
              <h2 className="text-[14.5px] font-semibold text-[#111315]">
                GPU Server riêng — Google Colab / Kaggle T4 miễn phí (Không giới hạn ký tự)
              </h2>
            </div>
            <a
              href={COLAB_NOTEBOOK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg btn-primary text-xs font-medium inline-flex items-center gap-1.5"
            >
              <span>Mở Google Colab (1-Click)</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          <p className="text-xs text-[#5C626E] leading-relaxed">
            Bấm <strong>Mở Google Colab</strong> → chọn <strong>Runtime → Change runtime type → T4 GPU</strong> → bấm <strong>Run all</strong> (~2 phút tải F5-TTS Việt 6000h). Sau đó copy link <code className="font-mono-tech text-[#111315]">https://xxxx.trycloudflare.com</code> dán vào đây để đọc truyện dài 10.000–100.000+ ký tự hoàn toàn miễn phí, không bao giờ bị khóa ZeroGPU.
          </p>

          <div className="flex items-center gap-2">
            <input
              type="url"
              value={f5UrlInput}
              onChange={(e) => setF5UrlInput(e.target.value)}
              placeholder="https://xxxx-xxxx-xxxx.trycloudflare.com"
              className="flex-1 px-3 py-2 rounded-lg bg-white border border-[#DCDFE4] text-xs font-mono-tech text-[#111315] placeholder-[#9CA3AF] focus:outline-none focus:border-[#111315]"
            />
            <button
              type="submit"
              disabled={testingGpu}
              className="px-4 py-2 rounded-lg btn-primary text-xs font-medium cursor-pointer shrink-0 flex items-center gap-1.5 disabled:opacity-60"
            >
              {testingGpu && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{testingGpu ? 'Đang kiểm tra...' : 'Lưu & Kiểm tra GPU'}</span>
            </button>
            {savedF5Url && (
              <button
                type="button"
                onClick={handleClearF5Server}
                className="p-2 rounded-lg btn-secondary text-[#DC2626] cursor-pointer shrink-0"
                title="Ngắt kết nối Colab GPU"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 text-xs font-mono-tech pt-0.5">
            {gpuHealth?.ok ? (
              <span className="text-[#15803D] font-medium flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5" />
                Đang kết nối: {gpuHealth.gpu} · {gpuHealth.model}
              </span>
            ) : gpuHealth && !gpuHealth.ok ? (
              <span className="text-[#DC2626]">{gpuHealth.error}</span>
            ) : savedF5Url ? (
              <span className="text-[#1D4ED8]">
                Đã lưu GPU Server: {savedF5Url} (nhấn &ldquo;Lưu &amp; Kiểm tra GPU&rdquo; để kiểm tra)
              </span>
            ) : (
              <span className="text-[#717784]">
                Trạng thái: Chưa gắn Colab GPU (đang dùng Hugging Face Space công cộng)
              </span>
            )}
          </div>
        </form>
      )}

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
            ? 'Trên Cloudflare Workers (Hono.js), F5-TTS Việt 6000h chạy trên NVIDIA ZeroGPU và gộp tới 1.000 ký tự mỗi lượt gọi để tiết kiệm 8× hạn mức. Dán 1 hoặc nhiều Hugging Face Token (Read) miễn phí từ huggingface.co/settings/tokens (cách nhau bằng dấu phẩy) để hệ thống tự động xoay vòng khi hết lượt.'
            : 'ViZipVoice 7000h đã chạy 100% offline trên máy bạn. Nếu muốn tăng tốc lên 2–4 giây/đoạn bằng NVIDIA A10G GPU miễn phí, dán mã token (Read) từ huggingface.co/settings/tokens vào đây.'}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={hfTokenInput}
            onChange={(e) => setHfTokenInput(e.target.value)}
            placeholder="hf_xxx1, hf_xxx2 (1 hoặc nhiều token cách nhau dấu phẩy)"
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
