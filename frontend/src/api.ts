import type {
  ClonedVoiceProfile,
  DialoguePayload,
  EngineStatus,
  JobRecord,
  StockVoiceInfo,
  SynthesizePayload,
} from './types';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      detail = data.detail || data.message || detail;
    } catch {
      const txt = await res.text();
      if (txt) detail = txt.slice(0, 240);
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getEngines: () => apiFetch<{ engines: EngineStatus[]; ffmpeg_ready: boolean }>('/api/engines'),

  getSettings: () => apiFetch<{ has_hf_token: boolean; hf_token_masked: string }>('/api/settings'),

  saveSettings: (hfToken: string) =>
    apiFetch<{ has_hf_token: boolean; hf_token_masked: string }>('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hf_token: hfToken }),
    }),

  prepareEngine: (engineId: string) =>
    apiFetch<{ status: string; message?: string }>(`/api/engines/${engineId}/prepare`, {
      method: 'POST',
    }),

  getStockVoices: (engine: string) =>
    apiFetch<{ voices: StockVoiceInfo[] }>(`/api/voices/stock?engine=${encodeURIComponent(engine)}`),

  getClonedVoices: () => apiFetch<{ voices: ClonedVoiceProfile[] }>('/api/voices/cloned'),

  createClonedVoice: async (formData: FormData) =>
    apiFetch<ClonedVoiceProfile>('/api/voices/cloned', {
      method: 'POST',
      body: formData,
    }),

  deleteClonedVoice: (voiceId: string) =>
    apiFetch<{ deleted: boolean }>(`/api/voices/cloned/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
    }),

  startSynthesis: (payload: SynthesizePayload) =>
    apiFetch<JobRecord>('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  startDialogue: (payload: DialoguePayload) =>
    apiFetch<JobRecord>('/api/tts/dialogue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  getJob: (jobId: string) => apiFetch<JobRecord>(`/api/jobs/${encodeURIComponent(jobId)}`),

  cancelJob: (jobId: string) =>
    apiFetch<{ cancelled: boolean }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    }),

  getHistory: () => apiFetch<{ jobs: JobRecord[] }>('/api/history'),

  toggleFavorite: (jobId: string) =>
    apiFetch<JobRecord>(`/api/history/${encodeURIComponent(jobId)}/favorite`, {
      method: 'POST',
    }),

  deleteHistoryJob: (jobId: string) =>
    apiFetch<{ deleted: boolean }>(`/api/history/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
    }),

  extractTextFromFile: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiFetch<{ filename: string; text: string; char_count: number }>('/api/text/extract', {
      method: 'POST',
      body: fd,
    });
  },

  subscribeJobEvents: (
    jobId: string,
    onUpdate: (job: JobRecord) => void,
    onDone?: (job: JobRecord) => void,
    onError?: (err: string) => void
  ): (() => void) => {
    const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    let closed = false;

    es.onmessage = (ev) => {
      try {
        const job = JSON.parse(ev.data) as JobRecord;
        onUpdate(job);
        if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
          if (!closed) {
            closed = true;
            es.close();
          }
          if (job.status === 'error') {
            onError?.(job.error || 'Synthesis failed');
          } else {
            onDone?.(job);
          }
        }
      } catch {
        // ignore heartbeat parse
      }
    };

    es.onerror = () => {
      if (!closed) {
        closed = true;
        es.close();
        // Fallback single fetch
        api
          .getJob(jobId)
          .then((j) => {
            onUpdate(j);
            if (j.status === 'completed' || j.status === 'cancelled') onDone?.(j);
            else if (j.status === 'error') onError?.(j.error || 'Connection error');
          })
          .catch(() => onError?.('Mất kết nối stream tiến độ'));
      }
    };

    return () => {
      closed = true;
      es.close();
    };
  },
};
