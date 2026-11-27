import React, { useMemo, useState } from 'react';
import {
  Download,
  FileText,
  FolderOpen,
  Heart,
  Play,
  Search,
  Trash2,
} from 'lucide-react';
import type { JobRecord } from '../types';

interface HistoryLibraryProps {
  history: JobRecord[];
  activeTrackId?: string;
  onPlayTrack: (job: JobRecord) => void;
  onToggleFavorite: (jobId: string) => void;
  onDeleteJob: (jobId: string) => void;
}

export const HistoryLibrary: React.FC<HistoryLibraryProps> = ({
  history,
  activeTrackId,
  onPlayTrack,
  onToggleFavorite,
  onDeleteJob,
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'fav' | 'cloned' | 'dialogue'>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter((j) => {
      if (filter === 'fav' && !j.favorite) return false;
      if (filter === 'cloned' && !j.cloned_voice_id) return false;
      if (filter === 'dialogue' && j.mode !== 'dialogue') return false;
      if (!q) return true;
      return (
        j.title.toLowerCase().includes(q) ||
        j.voice_name.toLowerCase().includes(q) ||
        j.text_preview.toLowerCase().includes(q)
      );
    });
  }, [history, query, filter]);

  return (
    <div className="max-w-5xl mx-auto px-6 lg:px-10 py-8 pb-32 space-y-6">
      <div className="border-b border-[#E5E7EB] pb-5">
        <h1 className="text-[22px] font-bold tracking-[-0.02em] text-[#111315]">
          Thư viện âm thanh
        </h1>
        <p className="text-[14px] text-[#5C626E] mt-1">
          Nghe lại, chỉnh EQ hoặc tải xuống bản thu MP3, WAV và phụ đề SRT đã tạo.
        </p>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="w-4 h-4 text-[#8C929D] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm theo tên, giọng đọc hoặc nội dung..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white border border-[#DCDFE4] text-[13px] text-[#111315] placeholder-[#9CA3AF] focus:outline-none focus:border-[#111315]"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {[
            { id: 'all', label: `Tất cả (${history.length})` },
            { id: 'fav', label: 'Yêu thích' },
            { id: 'cloned', label: 'Giọng Clone' },
            { id: 'dialogue', label: 'Podcast' },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id as typeof filter)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                filter === f.id
                  ? 'bg-[#111315] text-white border-[#111315]'
                  : 'bg-white text-[#525866] border-[#DCDFE4] hover:border-[#B8BEC9]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Track List — crisp table-like studio rows */}
      {filtered.length === 0 ? (
        <div className="panel rounded-xl p-12 text-center space-y-1.5">
          <FolderOpen className="w-7 h-7 text-[#9CA3AF] mx-auto mb-2" />
          <div className="text-[14px] font-medium text-[#111315]">Chưa có bản thu phù hợp</div>
          <p className="text-xs text-[#717784]">
            Các bản thu âm bạn tạo sẽ tự động xuất hiện và lưu trữ tại đây.
          </p>
        </div>
      ) : (
        <div className="panel rounded-xl divide-y divide-[#ECEEF2] overflow-hidden">
          {filtered.map((job) => {
            const isPlayingThis = activeTrackId === job.job_id;
            return (
              <div
                key={job.job_id}
                className={`p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 transition-colors ${
                  isPlayingThis ? 'bg-[#F5F6F8]' : 'hover:bg-[#FAFAFB]'
                }`}
              >
                <div className="flex items-start gap-3.5 min-w-0 flex-1">
                  <button
                    onClick={() => job.audio_url && onPlayTrack(job)}
                    disabled={!job.audio_url}
                    className="w-9 h-9 rounded-full btn-primary flex items-center justify-center shrink-0 mt-0.5 disabled:opacity-35 cursor-pointer"
                    title="Phát bản thu"
                  >
                    <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-[14px] font-semibold text-[#111315] truncate">
                        {job.title}
                      </h3>
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded font-medium ${
                          job.cloned_voice_id
                            ? 'bg-[#EFF6FF] text-[#1D4ED8]'
                            : 'bg-[#F3F4F6] text-[#525866]'
                        }`}
                      >
                        {job.voice_name}
                      </span>
                    </div>
                    <p className="text-xs text-[#717784] line-clamp-1 mt-1">{job.text_preview}</p>
                    <div className="flex items-center gap-2.5 mt-1.5 text-[11.5px] font-mono-tech text-[#8C929D] flex-wrap">
                      <span>{job.duration_sec}s</span>
                      <span>·</span>
                      <span>{job.char_count.toLocaleString()} ký tự</span>
                      <span>·</span>
                      <span>{job.total_chunks} đoạn</span>
                      <span>·</span>
                      <span>{new Date(job.created_at).toLocaleString('vi-VN')}</span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                  <button
                    onClick={() => onToggleFavorite(job.job_id)}
                    className={`p-1.5 rounded-md border transition-colors cursor-pointer ${
                      job.favorite
                        ? 'bg-[#FEF2F2] border-[#FECACA] text-[#DC2626]'
                        : 'bg-white border-[#DCDFE4] text-[#717784] hover:text-[#111315]'
                    }`}
                    title="Yêu thích"
                  >
                    <Heart className={`w-4 h-4 ${job.favorite ? 'fill-current' : ''}`} />
                  </button>

                  {job.audio_url && (
                    <a
                      href={job.audio_url}
                      download
                      className="px-2.5 py-1.5 rounded-md btn-secondary text-xs font-medium flex items-center gap-1"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span className="uppercase">{job.output_format}</span>
                    </a>
                  )}

                  {job.wav_url && job.output_format !== 'wav' && (
                    <a
                      href={job.wav_url}
                      download
                      className="px-2.5 py-1.5 rounded-md btn-secondary text-xs font-mono-tech"
                    >
                      WAV
                    </a>
                  )}

                  {job.subtitle_srt_url && (
                    <a
                      href={job.subtitle_srt_url}
                      download
                      className="px-2.5 py-1.5 rounded-md btn-secondary text-xs font-medium flex items-center gap-1"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span>SRT</span>
                    </a>
                  )}

                  <button
                    onClick={() => onDeleteJob(job.job_id)}
                    className="p-1.5 rounded-md text-[#8C929D] hover:text-[#DC2626] hover:bg-[#FEF2F2] cursor-pointer"
                    title="Xóa bản ghi"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
