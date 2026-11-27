export type EngineId = 'edge' | 'vizipvoice' | 'zipvoice_gpu' | 'f5_gpu' | 'vieneu' | 'kokoro' | 'hybrid_clone';

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

export interface ClonedVoiceProfile {
  id: string;
  name: string;
  language: string;
  gender: string;
  description: string;
  tags: string[];
  avatar_gradient: string;
  audio_filename: string;
  audio_url: string;
  duration_sec: number;
  quality_score: number;
  quality_note: string;
  ref_text: string;
  waveform_peaks: number[];
  pitch_hz: number;
  created_at: string;
}

export interface ChunkProgress {
  index: number;
  text_preview: string;
  char_count: number;
  status: 'queued' | 'processing' | 'done' | 'error';
  duration_sec: number;
  speaker?: string | null;
}

export interface JobRecord {
  job_id: string;
  title: string;
  mode: 'single' | 'dialogue';
  status: 'queued' | 'running' | 'stitching' | 'completed' | 'cancelled' | 'error';
  progress: number;
  current_chunk: number;
  total_chunks: number;
  chunks: ChunkProgress[];
  engine: string;
  voice_name: string;
  cloned_voice_id?: string | null;
  char_count: number;
  word_count: number;
  duration_sec: number;
  output_format: string;
  audio_url?: string | null;
  wav_url?: string | null;
  subtitle_srt_url?: string | null;
  subtitle_vtt_url?: string | null;
  waveform_peaks: number[];
  text_preview: string;
  favorite: boolean;
  error?: string | null;
  created_at: string;
  extra?: Record<string, unknown>;
}

export interface EngineStatus {
  id: string;
  name: string;
  source_repo: string;
  ready: boolean;
  installed?: boolean;
  downloaded?: boolean;
  loaded?: boolean;
  downloading?: boolean;
  loading?: boolean;
  download_progress?: number;
  download_stage?: string;
  last_error?: string | null;
  supports_cloning: boolean;
  supports_blending: boolean;
  supports_subtitles: boolean;
  max_chunk_chars: number;
  badge: string;
  description: string;
}

export interface SynthesizePayload {
  title?: string;
  text: string;
  engine: EngineId;
  voice_id: string;
  cloned_voice_id?: string | null;
  speed: number;
  pitch: number;
  volume: number;
  pause_ms: number;
  crossfade_ms: number;
  output_format: 'mp3' | 'wav';
  normalize_audio: boolean;
  generate_subtitles: boolean;
  blend_voice_id?: string | null;
  blend_ratio?: number;
  temperature?: number;
  clone_strength?: number;
  quality_mode?: 'turbo' | 'balanced' | 'high';
}

export interface DialogueLine {
  id: string;
  speaker: string;
  text: string;
  engine: EngineId;
  voice_id: string;
  cloned_voice_id?: string | null;
  speed: number;
  pitch: number;
  pause_after_ms: number;
}

export interface DialoguePayload {
  title: string;
  lines: DialogueLine[];
  output_format: 'mp3' | 'wav';
  normalize_audio: boolean;
  generate_subtitles: boolean;
}

export type ActiveTab = 'studio' | 'clone' | 'dialogue' | 'library' | 'engines';
