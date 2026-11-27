import type { ClonedVoiceProfile, JobRecord } from './types';

const DB_NAME = 'voxforge_cloud_vault';
const DB_VERSION = 1;
const STORE_VOICES = 'voices';
const STORE_JOBS = 'jobs';
const HF_TOKEN_KEY = 'voxforge_hf_token';

interface StoredVoiceRow {
  id: string;
  profile: ClonedVoiceProfile;
  audioBlob: Blob;
}

interface StoredJobRow {
  job_id: string;
  record: JobRecord;
  audioBlob?: Blob;
  srtText?: string;
  vttText?: string;
}

const blobUrlCache = new Map<string, string>();

function getOrCreateBlobUrl(cacheKey: string, blob: Blob): string {
  const existing = blobUrlCache.get(cacheKey);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(cacheKey, url);
  return url;
}

function revokeKey(cacheKey: string) {
  const existing = blobUrlCache.get(cacheKey);
  if (existing) {
    URL.revokeObjectURL(existing);
    blobUrlCache.delete(cacheKey);
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VOICES)) {
        db.createObjectStore(STORE_VOICES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_JOBS)) {
        db.createObjectStore(STORE_JOBS, { keyPath: 'job_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Không mở được IndexedDB.'));
  });
}

function hydrateVoice(row: StoredVoiceRow): ClonedVoiceProfile {
  return {
    ...row.profile,
    audio_url: getOrCreateBlobUrl(`voice:${row.id}`, row.audioBlob),
  };
}

function hydrateJob(row: StoredJobRow): JobRecord {
  const rec: JobRecord = { ...row.record };
  if (row.audioBlob) {
    const url = getOrCreateBlobUrl(`job:${row.job_id}:audio`, row.audioBlob);
    rec.audio_url = url;
    if (row.record.output_format === 'wav') {
      rec.wav_url = url;
    }
  }
  if (row.srtText) {
    rec.subtitle_srt_url = getOrCreateBlobUrl(
      `job:${row.job_id}:srt`,
      new Blob([row.srtText], { type: 'text/plain;charset=utf-8' })
    );
  }
  if (row.vttText) {
    rec.subtitle_vtt_url = getOrCreateBlobUrl(
      `job:${row.job_id}:vtt`,
      new Blob([row.vttText], { type: 'text/vtt;charset=utf-8' })
    );
  }
  return rec;
}

export function getLocalHfToken(): string {
  try {
    return window.localStorage.getItem(HF_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setLocalHfToken(token: string): void {
  try {
    const clean = token.trim();
    if (clean) {
      window.localStorage.setItem(HF_TOKEN_KEY, clean);
    } else {
      window.localStorage.removeItem(HF_TOKEN_KEY);
    }
  } catch {
    // ignore storage quota / private mode errors
  }
}

export function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 10) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export const localVault = {
  async listVoices(): Promise<ClonedVoiceProfile[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VOICES, 'readonly');
      const req = tx.objectStore(STORE_VOICES).getAll();
      req.onsuccess = () => {
        const rows = (req.result as StoredVoiceRow[]) || [];
        rows.sort((a, b) => (b.profile.created_at || '').localeCompare(a.profile.created_at || ''));
        resolve(rows.map(hydrateVoice));
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getVoiceRow(voiceId: string): Promise<StoredVoiceRow | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VOICES, 'readonly');
      const req = tx.objectStore(STORE_VOICES).get(voiceId);
      req.onsuccess = () => resolve((req.result as StoredVoiceRow) || null);
      req.onerror = () => reject(req.error);
    });
  },

  async saveVoice(profile: ClonedVoiceProfile, audioBlob: Blob): Promise<ClonedVoiceProfile> {
    const db = await openDb();
    const row: StoredVoiceRow = { id: profile.id, profile, audioBlob };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_VOICES, 'readwrite');
      tx.objectStore(STORE_VOICES).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return hydrateVoice(row);
  },

  async deleteVoice(voiceId: string): Promise<void> {
    const db = await openDb();
    revokeKey(`voice:${voiceId}`);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_VOICES, 'readwrite');
      tx.objectStore(STORE_VOICES).delete(voiceId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async listJobs(): Promise<JobRecord[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readonly');
      const req = tx.objectStore(STORE_JOBS).getAll();
      req.onsuccess = () => {
        const rows = (req.result as StoredJobRow[]) || [];
        rows.sort((a, b) => (b.record.created_at || '').localeCompare(a.record.created_at || ''));
        resolve(rows.map(hydrateJob));
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getJob(jobId: string): Promise<JobRecord | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readonly');
      const req = tx.objectStore(STORE_JOBS).get(jobId);
      req.onsuccess = () => {
        const row = req.result as StoredJobRow | undefined;
        resolve(row ? hydrateJob(row) : null);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async saveJob(
    record: JobRecord,
    assets?: { audioBlob?: Blob; srtText?: string; vttText?: string }
  ): Promise<JobRecord> {
    const db = await openDb();
    const row: StoredJobRow = {
      job_id: record.job_id,
      record: {
        ...record,
        audio_url: null,
        wav_url: null,
        subtitle_srt_url: null,
        subtitle_vtt_url: null,
      },
      audioBlob: assets?.audioBlob,
      srtText: assets?.srtText,
      vttText: assets?.vttText,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readwrite');
      tx.objectStore(STORE_JOBS).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return hydrateJob(row);
  },

  async toggleFavorite(jobId: string): Promise<JobRecord> {
    const db = await openDb();
    const row = await new Promise<StoredJobRow | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readonly');
      const req = tx.objectStore(STORE_JOBS).get(jobId);
      req.onsuccess = () => resolve(req.result as StoredJobRow | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!row) throw new Error('Không tìm thấy bản thu.');
    row.record.favorite = !row.record.favorite;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readwrite');
      tx.objectStore(STORE_JOBS).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return hydrateJob(row);
  },

  async deleteJob(jobId: string): Promise<void> {
    const db = await openDb();
    revokeKey(`job:${jobId}:audio`);
    revokeKey(`job:${jobId}:srt`);
    revokeKey(`job:${jobId}:vtt`);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readwrite');
      tx.objectStore(STORE_JOBS).delete(jobId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};
