import React, { useEffect, useRef, useState } from 'react';
import {
  Download,
  FileText,
  Heart,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { JobRecord } from '../types';

interface AudioMasteringDockProps {
  track: JobRecord | null;
  onToggleFavorite?: (jobId: string) => void;
  onClose?: () => void;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const AudioMasteringDock: React.FC<AudioMasteringDockProps> = ({
  track,
  onToggleFavorite,
  onClose,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const bassNodeRef = useRef<BiquadFilterNode | null>(null);
  const midNodeRef = useRef<BiquadFilterNode | null>(null);
  const trebleNodeRef = useRef<BiquadFilterNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const ambienceNodeRef = useRef<AudioNode | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.95);
  const [muted, setMuted] = useState(false);
  const [fxOpen, setFxOpen] = useState(false);

  const [bassDb, setBassDb] = useState(0);
  const [presenceDb, setPresenceDb] = useState(0);
  const [reverbAmt, setReverbAmt] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [ambienceMode, setAmbienceMode] = useState<'off' | 'rain' | 'studio'>('off');

  const fxActive = bassDb !== 0 || presenceDb !== 0 || reverbAmt > 0 || ambienceMode !== 'off';

  const ensureAudioGraph = () => {
    const audioEl = audioRef.current;
    if (!audioEl) return;

    if (!audioCtxRef.current) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;

      const source = ctx.createMediaElementSource(audioEl);
      sourceNodeRef.current = source;

      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 140;
      bass.gain.value = bassDb;
      bassNodeRef.current = bass;

      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = 2800;
      mid.Q.value = 1.1;
      mid.gain.value = presenceDb;
      midNodeRef.current = mid;

      const treble = ctx.createBiquadFilter();
      treble.type = 'highshelf';
      treble.frequency.value = 9500;
      treble.gain.value = 0;
      trebleNodeRef.current = treble;

      const convolver = ctx.createConvolver();
      const irLen = Math.floor(ctx.sampleRate * 1.4);
      const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < irLen; i++) {
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2);
        }
      }
      convolver.buffer = ir;

      const dryGain = ctx.createGain();
      dryGain.gain.value = 1.0;
      dryGainRef.current = dryGain;

      const wetGain = ctx.createGain();
      wetGain.gain.value = reverbAmt;
      wetGainRef.current = wetGain;

      source.connect(bass);
      bass.connect(mid);
      mid.connect(treble);
      treble.connect(dryGain);
      treble.connect(convolver);
      convolver.connect(wetGain);
      dryGain.connect(ctx.destination);
      wetGain.connect(ctx.destination);
    }

    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
  };

  useEffect(() => {
    if (fxActive) ensureAudioGraph();
    if (bassNodeRef.current) bassNodeRef.current.gain.value = bassDb;
    if (midNodeRef.current) midNodeRef.current.gain.value = presenceDb;
    if (wetGainRef.current) wetGainRef.current.gain.value = reverbAmt;
    if (dryGainRef.current) dryGainRef.current.gain.value = Math.max(0.55, 1 - reverbAmt * 0.45);
  }, [fxActive, bassDb, presenceDb, reverbAmt]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    const cleanup = () => {
      try {
        if (ambienceNodeRef.current && 'stop' in ambienceNodeRef.current) {
          (ambienceNodeRef.current as AudioBufferSourceNode).stop();
        }
        ambienceNodeRef.current?.disconnect();
      } catch {
        // ignore
      }
      ambienceNodeRef.current = null;
    };

    cleanup();
    if (ambienceMode === 'off' || !isPlaying || !audioCtxRef.current) return cleanup;

    const ctx = audioCtxRef.current;
    const gain = ctx.createGain();
    gain.gain.value = 0.038;

    const bufLen = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < bufLen; i++) {
      const white = Math.random() * 2 - 1;
      data[i] = (lastOut + 0.04 * white) / 1.04;
      lastOut = data[i];
      data[i] *= ambienceMode === 'rain' ? 2.4 : 1.1;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = ambienceMode === 'rain' ? 'bandpass' : 'lowpass';
    filter.frequency.value = ambienceMode === 'rain' ? 1100 : 280;
    filter.Q.value = ambienceMode === 'rain' ? 0.6 : 1.0;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    ambienceNodeRef.current = src;

    return cleanup;
  }, [ambienceMode, isPlaying]);

  useEffect(() => {
    if (!track?.audio_url || !audioRef.current) return;
    const el = audioRef.current;
    el.src = track.audio_url;
    el.load();
    setCurrentTime(0);
    setDuration(track.duration_sec || 0);
    if (fxActive) ensureAudioGraph();
    el.play()
      .then(() => setIsPlaying(true))
      .catch(() => setIsPlaying(false));
  }, [track?.job_id, track?.audio_url]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume;
  }, [volume, muted]);

  // Crisp studio ink waveform with tape-deck red playhead
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || !track) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const peaks =
      track.waveform_peaks && track.waveform_peaks.length > 0
        ? track.waveform_peaks
        : Array.from({ length: 120 }, (_, i) => 0.25 + 0.55 * Math.abs(Math.sin(i * 0.27)));

    const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
    const count = peaks.length;
    const barGap = 2;
    const barW = Math.max(1.5, (w - (count - 1) * barGap) / count);

    for (let i = 0; i < count; i++) {
      const p = peaks[i];
      const barH = Math.max(3, p * (h - 6));
      const x = i * (barW + barGap);
      const y = (h - barH) / 2;
      const frac = i / count;

      ctx.fillStyle = frac <= progress ? '#111315' : '#D5D8DF';
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, 1.5);
      ctx.fill();
    }

    // Physical red needle playhead
    const headX = progress * w;
    ctx.fillStyle = '#DC2626';
    ctx.fillRect(Math.max(0, headX - 0.75), 1, 1.5, h - 2);
  }, [track, currentTime, duration]);

  if (!track || !track.audio_url) return null;

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (fxActive) ensureAudioGraph();
    if (el.paused) {
      el.play()
        .then(() => setIsPlaying(true))
        .catch(() => {});
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const seekBy = (delta: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(duration || 0, el.currentTime + delta));
  };

  const handleWaveformClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setCurrentTime(el.currentTime);
  };

  return (
    <div className="fixed bottom-0 left-0 lg:left-[236px] right-0 z-40 border-t border-[#E2E4E9] bg-white shadow-[0_-6px_24px_rgba(17,19,21,0.06)]">
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || track.duration_sec || 0)}
        onEnded={() => setIsPlaying(false)}
      />

      {/* Expandable EQ & Ambience Rack */}
      {fxOpen && (
        <div className="border-b border-[#E5E7EB] bg-[#FAFAFB] px-6 py-4">
          <div className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="text-[#525866] font-medium">Âm trầm (140 Hz)</span>
                <span className="font-mono-tech text-[#111315]">
                  {bassDb >= 0 ? `+${bassDb}` : bassDb} dB
                </span>
              </div>
              <input
                type="range"
                min={-10}
                max={10}
                step={0.5}
                value={bassDb}
                onChange={(e) => setBassDb(Number(e.target.value))}
                className="w-full fader"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="text-[#525866] font-medium">Độ rõ giọng (2.8 kHz)</span>
                <span className="font-mono-tech text-[#111315]">
                  {presenceDb >= 0 ? `+${presenceDb}` : presenceDb} dB
                </span>
              </div>
              <input
                type="range"
                min={-8}
                max={10}
                step={0.5}
                value={presenceDb}
                onChange={(e) => setPresenceDb(Number(e.target.value))}
                className="w-full fader"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="text-[#525866] font-medium">Độ vang phòng thu</span>
                <span className="font-mono-tech text-[#111315]">{Math.round(reverbAmt * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={0.6}
                step={0.05}
                value={reverbAmt}
                onChange={(e) => setReverbAmt(Number(e.target.value))}
                className="w-full fader"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="text-[#525866] font-medium">Âm nền &amp; tốc độ phát</span>
                <span className="font-mono-tech text-[#111315]">{playbackRate.toFixed(2)}x</span>
              </div>
              <div className="flex items-center gap-1.5">
                {(['off', 'rain', 'studio'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setAmbienceMode(m)}
                    className={`flex-1 py-1 rounded-md text-[11.5px] font-medium border transition-colors cursor-pointer ${
                      ambienceMode === m
                        ? 'bg-[#111315] text-white border-[#111315]'
                        : 'bg-white text-[#525866] border-[#DCDFE4] hover:border-[#B8BEC9]'
                    }`}
                  >
                    {m === 'off' ? 'Tắt' : m === 'rain' ? 'Mưa nhẹ' : 'Phòng ấm'}
                  </button>
                ))}
                <button
                  onClick={() =>
                    setPlaybackRate((r) => (r >= 1.5 ? 0.75 : Number((r + 0.25).toFixed(2))))
                  }
                  className="px-2 py-1 rounded-md text-[11.5px] font-mono-tech bg-white text-[#111315] border border-[#DCDFE4] hover:bg-[#F4F5F7] cursor-pointer"
                  title="Đổi tốc độ phát"
                >
                  {playbackRate}x
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Transport Strip */}
      <div className="px-4 lg:px-6 py-2.5 flex flex-wrap lg:flex-nowrap items-center gap-4">
        {/* Track Meta */}
        <div className="min-w-[170px] max-w-[240px] shrink-0">
          <div className="text-[13px] font-semibold text-[#111315] truncate">{track.title}</div>
          <div className="text-[11.5px] text-[#717784] truncate">
            {track.voice_name} ·{' '}
            <span className="font-mono-tech">{track.char_count.toLocaleString()} ký tự</span>
          </div>
        </div>

        {/* Transport */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => seekBy(-5)}
            className="p-1.5 rounded-md text-[#525866] hover:text-[#111315] hover:bg-[#F3F4F6] transition-colors cursor-pointer"
            title="Lùi 5 giây"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={togglePlay}
            className="w-9 h-9 rounded-full btn-primary flex items-center justify-center cursor-pointer"
            title={isPlaying ? 'Tạm dừng' : 'Phát'}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 fill-current" />
            ) : (
              <Play className="w-4 h-4 fill-current ml-0.5" />
            )}
          </button>
          <button
            onClick={() => seekBy(5)}
            className="p-1.5 rounded-md text-[#525866] hover:text-[#111315] hover:bg-[#F3F4F6] transition-colors cursor-pointer"
            title="Tới 5 giây"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>

        {/* Interactive Waveform */}
        <div className="flex-1 min-w-[200px] flex items-center gap-2.5">
          <span className="text-[11px] font-mono-tech text-[#525866] w-10 text-right shrink-0">
            {formatTime(currentTime)}
          </span>
          <canvas
            ref={waveformCanvasRef}
            onClick={handleWaveformClick}
            className="w-full h-9 cursor-pointer"
            title="Nhấp để tua đến vị trí bất kỳ"
          />
          <span className="text-[11px] font-mono-tech text-[#717784] w-10 shrink-0">
            {formatTime(duration)}
          </span>
        </div>

        {/* Controls & Export */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setFxOpen((v) => !v)}
            className={`px-2.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 border transition-colors cursor-pointer ${
              fxOpen
                ? 'bg-[#111315] text-white border-[#111315]'
                : 'bg-white text-[#3F444E] border-[#DCDFE4] hover:bg-[#F4F5F7]'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">EQ</span>
          </button>

          <div className="hidden xl:flex items-center gap-1.5 px-1.5">
            <button
              onClick={() => setMuted((m) => !m)}
              className="text-[#525866] hover:text-[#111315] cursor-pointer"
            >
              {muted || volume === 0 ? (
                <VolumeX className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                setMuted(false);
                setVolume(Number(e.target.value));
              }}
              className="w-16 fader"
            />
          </div>

          {onToggleFavorite && (
            <button
              onClick={() => onToggleFavorite(track.job_id)}
              className={`p-1.5 rounded-md border transition-colors cursor-pointer ${
                track.favorite
                  ? 'bg-[#FEF2F2] border-[#FECACA] text-[#DC2626]'
                  : 'bg-white border-[#DCDFE4] text-[#717784] hover:text-[#111315]'
              }`}
              title="Lưu yêu thích"
            >
              <Heart className={`w-4 h-4 ${track.favorite ? 'fill-current' : ''}`} />
            </button>
          )}

          <a
            href={track.audio_url}
            download
            className="px-2.5 py-1.5 rounded-md btn-secondary text-xs font-medium flex items-center gap-1"
            title="Tải file âm thanh"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="uppercase">{track.output_format}</span>
          </a>

          {track.subtitle_srt_url && (
            <a
              href={track.subtitle_srt_url}
              download
              className="px-2.5 py-1.5 rounded-md btn-secondary text-xs font-medium flex items-center gap-1"
              title="Tải phụ đề SRT"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>SRT</span>
            </a>
          )}

          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-[#8C929D] hover:text-[#111315] hover:bg-[#F3F4F6] cursor-pointer"
              title="Đóng trình phát"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
