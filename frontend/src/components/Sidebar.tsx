import React from 'react';
import {
  AudioLines,
  Cpu,
  Fingerprint,
  FolderOpen,
  Users,
} from 'lucide-react';
import type { ActiveTab, EngineStatus } from '../types';

interface SidebarProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  clonedCount: number;
  historyCount: number;
  engines: EngineStatus[];
  isGenerating: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  clonedCount,
  historyCount,
  engines,
  isGenerating,
}) => {
  const navItems: {
    id: ActiveTab;
    label: string;
    icon: React.ReactNode;
    count?: number | string;
    liveDot?: boolean;
  }[] = [
    {
      id: 'studio',
      label: 'Tạo giọng nói',
      icon: <AudioLines className="w-[17px] h-[17px]" />,
      liveDot: isGenerating,
    },
    {
      id: 'clone',
      label: 'Kho giọng Clone',
      icon: <Fingerprint className="w-[17px] h-[17px]" />,
      count: clonedCount > 0 ? clonedCount : undefined,
    },
    {
      id: 'dialogue',
      label: 'Hội thoại Podcast',
      icon: <Users className="w-[17px] h-[17px]" />,
    },
    {
      id: 'library',
      label: 'Thư viện',
      icon: <FolderOpen className="w-[17px] h-[17px]" />,
      count: historyCount > 0 ? historyCount : undefined,
    },
    {
      id: 'engines',
      label: 'Mô hình AI',
      icon: <Cpu className="w-[17px] h-[17px]" />,
      count: `${engines.filter((e) => e.ready).length}/${engines.length || 4}`,
    },
  ];

  return (
    <aside className="w-full lg:w-[236px] shrink-0 border-b lg:border-b-0 lg:border-r border-[#E5E7EB] bg-[#F5F5F6] flex flex-col justify-between z-20 select-none">
      <div>
        {/* Minimal Brand Mark — Braun / Teenage Engineering restraint */}
        <div className="h-14 px-5 flex items-center justify-between border-b border-[#E5E7EB]">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-end gap-[2.5px] h-4" aria-hidden="true">
              <span className="w-[2.5px] h-2 bg-[#111315] rounded-full" />
              <span className="w-[2.5px] h-4 bg-[#111315] rounded-full" />
              <span className="w-[2.5px] h-2.5 bg-[#DC2626] rounded-full" />
            </span>
            <span className="font-bold text-[15px] tracking-[-0.02em] text-[#111315]">
              VoxForge
            </span>
          </div>
          <span className="text-[11px] font-mono-tech text-[#8C929D]">v1.0</span>
        </div>

        {/* Navigation */}
        <nav className="p-2.5 flex flex-wrap lg:flex-col gap-0.5">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`flex items-center justify-between gap-2.5 px-3 py-2 rounded-lg text-[13.5px] transition-colors cursor-pointer ${
                  active
                    ? 'bg-white text-[#111315] font-semibold border border-[#E2E4E9] shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                    : 'text-[#525866] hover:text-[#111315] hover:bg-black/[0.04] border border-transparent font-medium'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className={active ? 'text-[#111315]' : 'text-[#717784]'}>
                    {item.icon}
                  </span>
                  <span className="truncate">{item.label}</span>
                </div>

                {item.liveDot ? (
                  <span className="w-2 h-2 rounded-full bg-[#DC2626] animate-pulse shrink-0" />
                ) : item.count !== undefined ? (
                  <span className="text-[11px] font-mono-tech text-[#717784] shrink-0">
                    {item.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Quiet bottom engine status */}
      <div className="hidden lg:block px-4 py-4 border-t border-[#E5E7EB]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-medium text-[#717784]">Trạng thái hệ thống</span>
          <button
            onClick={() => onTabChange('engines')}
            className="text-[11px] font-medium text-[#111315] hover:underline cursor-pointer"
          >
            Chi tiết
          </button>
        </div>
        <div className="space-y-1.5">
          {engines.slice(0, 4).map((eng) => (
            <div
              key={eng.id}
              className="flex items-center justify-between text-[12px] text-[#525866]"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    eng.downloading || eng.loading
                      ? 'bg-[#D97706] animate-pulse'
                      : eng.ready
                        ? 'bg-[#15803D]'
                        : 'bg-[#C4C9D1]'
                  }`}
                />
                <span className="truncate">{eng.name.replace(' (Clone AI)', '')}</span>
              </div>
              <span className="text-[10.5px] font-mono-tech text-[#8C929D] shrink-0">
                {eng.downloading
                  ? `${Math.round(eng.download_progress || 0)}%`
                  : eng.ready
                    ? 'Sẵn sàng'
                    : 'Chưa tải'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
};
