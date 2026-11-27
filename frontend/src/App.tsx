import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { AudioMasteringDock } from './components/AudioMasteringDock';
import { DialogueDirector } from './components/DialogueDirector';
import { EngineHub } from './components/EngineHub';
import { HistoryLibrary } from './components/HistoryLibrary';
import { Sidebar } from './components/Sidebar';
import { StudioWorkspace } from './components/StudioWorkspace';
import { VoiceVault } from './components/VoiceVault';
import type {
  ActiveTab,
  ClonedVoiceProfile,
  DialoguePayload,
  EngineStatus,
  JobRecord,
  StockVoiceInfo,
  SynthesizePayload,
} from './types';

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('studio');
  const [engines, setEngines] = useState<EngineStatus[]>([]);
  const [ffmpegReady, setFfmpegReady] = useState(true);
  const [stockVoicesByEngine, setStockVoicesByEngine] = useState<Record<string, StockVoiceInfo[]>>({});
  const [clonedVoices, setClonedVoices] = useState<ClonedVoiceProfile[]>([]);
  const [history, setHistory] = useState<JobRecord[]>([]);

  const [selectedClonedId, setSelectedClonedId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<JobRecord | null>(null);
  const [playingTrack, setPlayingTrack] = useState<JobRecord | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);

  const refreshEngines = useCallback(async () => {
    try {
      const data = await api.getEngines();
      setEngines(data.engines);
      setFfmpegReady(data.ffmpeg_ready);
    } catch {
      // ignore initial boot transient
    }
  }, []);

  const refreshClonedVoices = useCallback(async () => {
    try {
      const data = await api.getClonedVoices();
      setClonedVoices(data.voices);
    } catch {
      // ignore
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const data = await api.getHistory();
      setHistory(data.jobs);
    } catch {
      // ignore
    }
  }, []);

  const loadAllStockVoices = useCallback(async () => {
    const engineIds = ['edge', 'vieneu', 'kokoro'];
    const entries = await Promise.all(
      engineIds.map(async (id): Promise<[string, StockVoiceInfo[]]> => {
        try {
          const res = await api.getStockVoices(id);
          return [id, res.voices];
        } catch {
          return [id, []];
        }
      })
    );
    const map: Record<string, StockVoiceInfo[]> = {};
    for (const [id, list] of entries) {
      map[id] = list;
    }
    map['hybrid_clone'] = map['edge'] || [];
    setStockVoicesByEngine(map);
  }, []);

  useEffect(() => {
    refreshEngines();
    refreshClonedVoices();
    refreshHistory();
    loadAllStockVoices();
  }, [refreshEngines, refreshClonedVoices, refreshHistory, loadAllStockVoices]);

  useEffect(() => {
    const anyBusy = engines.some((e) => e.downloading || e.loading);
    if (!anyBusy) return;
    const t = window.setInterval(refreshEngines, 1500);
    return () => window.clearInterval(t);
  }, [engines, refreshEngines]);

  useEffect(() => {
    return () => {
      unsubRef.current?.();
    };
  }, []);

  const watchJob = useCallback(
    (job: JobRecord) => {
      unsubRef.current?.();
      setActiveJob(job);
      unsubRef.current = api.subscribeJobEvents(
        job.job_id,
        (updated) => {
          setActiveJob(updated);
        },
        (finalJob) => {
          setActiveJob(finalJob);
          refreshHistory();
          refreshEngines();
          if (finalJob.status === 'completed' && finalJob.audio_url) {
            setPlayingTrack(finalJob);
          }
        },
        () => {
          refreshHistory();
        }
      );
    },
    [refreshHistory, refreshEngines]
  );

  const handleStartSynthesis = async (payload: SynthesizePayload) => {
    const job = await api.startSynthesis(payload);
    watchJob(job);
  };

  const handleStartDialogue = async (payload: DialoguePayload) => {
    const job = await api.startDialogue(payload);
    watchJob(job);
  };

  const handleCancelJob = async (jobId: string) => {
    await api.cancelJob(jobId);
    refreshHistory();
  };

  const handleToggleFavorite = async (jobId: string) => {
    try {
      const updated = await api.toggleFavorite(jobId);
      setHistory((prev) => prev.map((j) => (j.job_id === jobId ? updated : j)));
      if (playingTrack?.job_id === jobId) {
        setPlayingTrack(updated);
      }
    } catch {
      // ignore
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    try {
      await api.deleteHistoryJob(jobId);
      setHistory((prev) => prev.filter((j) => j.job_id !== jobId));
      if (playingTrack?.job_id === jobId) {
        setPlayingTrack(null);
      }
    } catch {
      // ignore
    }
  };

  const handleUseVoiceInStudio = (voiceId: string) => {
    setSelectedClonedId(voiceId);
    setActiveTab('studio');
  };

  const isGenerating = Boolean(
    activeJob &&
      (activeJob.status === 'queued' ||
        activeJob.status === 'running' ||
        activeJob.status === 'stitching')
  );

  return (
    <div className="min-h-screen bg-[#FAFAFA] flex flex-col lg:flex-row text-[#111315]">
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        clonedCount={clonedVoices.length}
        historyCount={history.length}
        engines={engines}
        isGenerating={isGenerating}
      />

      <main className="flex-1 min-w-0 overflow-y-auto">
        {activeTab === 'studio' && (
          <StudioWorkspace
            engines={engines}
            stockVoicesByEngine={stockVoicesByEngine}
            clonedVoices={clonedVoices}
            activeJob={activeJob}
            selectedClonedId={selectedClonedId}
            onSelectClonedId={setSelectedClonedId}
            onStartSynthesis={handleStartSynthesis}
            onCancelJob={handleCancelJob}
            onPlayTrack={setPlayingTrack}
            onGoToVault={() => setActiveTab('clone')}
            onGoToEngines={() => setActiveTab('engines')}
          />
        )}

        {activeTab === 'clone' && (
          <VoiceVault
            clonedVoices={clonedVoices}
            onVoicesChanged={refreshClonedVoices}
            onUseVoiceInStudio={handleUseVoiceInStudio}
          />
        )}

        {activeTab === 'dialogue' && (
          <DialogueDirector
            stockVoicesByEngine={stockVoicesByEngine}
            clonedVoices={clonedVoices}
            activeJob={activeJob}
            onStartDialogue={handleStartDialogue}
            onPlayTrack={setPlayingTrack}
          />
        )}

        {activeTab === 'library' && (
          <HistoryLibrary
            history={history}
            activeTrackId={playingTrack?.job_id}
            onPlayTrack={setPlayingTrack}
            onToggleFavorite={handleToggleFavorite}
            onDeleteJob={handleDeleteJob}
          />
        )}

        {activeTab === 'engines' && (
          <EngineHub
            engines={engines}
            ffmpegReady={ffmpegReady}
            onRefreshEngines={refreshEngines}
          />
        )}
      </main>

      <AudioMasteringDock
        track={playingTrack}
        onToggleFavorite={handleToggleFavorite}
        onClose={() => setPlayingTrack(null)}
      />
    </div>
  );
}

export default App;
