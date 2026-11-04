import { useEffect, useRef, useState } from 'react';
import { FolderOpen, LoaderCircle, X } from 'lucide-react';
import type { AppSettings } from '../shared/types';
import { api, errorMessage } from './api';
import { useOverlayFocus } from './useOverlayFocus';

export function SettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const modal = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const showDefaultHint = Boolean(settings && path.trim() !== settings.defaultSessionsDir);
  useOverlayFocus({ container: modal, initialFocus: close, modal: true, onClose });
  useEffect(() => { const controller = new AbortController(); api<AppSettings>('/api/settings', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setSettings(value); setPath(value.sessionsDir); } }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); }); return () => controller.abort(); }, []);
  useEffect(() => { if (settings) input.current?.focus(); }, [settings]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!path.trim()) { setError('请输入会话日志目录'); return; }
    setSaving(true); setError('');
    try { await api<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify({ sessionsDir: path.trim() }) }); onSaved(); onClose(); } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  }
  return <div className="modal-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-[#111c18]/40 p-[20px] max-[560px]:p-[16px]" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={modal} className="settings-modal max-h-[calc(100dvh-40px)] w-[510px] max-w-full overflow-y-auto rounded-[12px] border border-(--border) bg-(--panel) p-[28px] text-(--text) shadow-(--shadow) max-[560px]:max-h-[calc(100dvh-32px)] max-[560px]:p-[20px]" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-description" tabIndex={-1}>
      <div className="modal-heading flex items-center justify-between gap-[16px]">
        <h2 id="settings-title" className="m-0 text-[18px] leading-[1.4] font-semibold">日志目录</h2>
        <button ref={close} className="icon-button" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
      </div>
      <form onSubmit={event => void save(event)} className="mt-6 min-w-0">
        <label className="field-label mb-[8px] flex items-center gap-[8px] text-[14px] font-medium text-(--soft)" htmlFor="sessions-directory"><FolderOpen size={15} aria-hidden="true" />Codex 会话日志</label>
        <input ref={input} id="sessions-directory" className="directory-input block h-[40px] w-full min-w-0 rounded-[6px] border border-(--control) bg-(--bg) px-[12px] font-mono text-[12px] text-(--text) outline-offset-[3px] placeholder:text-(--muted) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:cursor-default disabled:opacity-60 max-[560px]:h-[44px]" value={path} onChange={event => setPath(event.target.value)} placeholder={settings ? settings.defaultSessionsDir : '正在读取设置…'} aria-describedby={[showDefaultHint && 'directory-hint', error && 'settings-error'].filter(Boolean).join(' ') || undefined} disabled={!settings || saving} />
        {showDefaultHint && <p id="directory-hint" className="field-hint mt-[8px] mb-0 text-[12px] leading-[1.8] text-(--muted) [overflow-wrap:anywhere]">默认目录：{settings!.defaultSessionsDir}</p>}
        {error && <p id="settings-error" className="inline-error mt-[12px] mb-0 rounded-[6px] border border-(--danger)/25 bg-(--bg) p-[12px] text-[12px] leading-[1.8] text-(--danger) [overflow-wrap:anywhere]" role="alert">{error}</p>}
        <div className="modal-actions mt-[24px] flex flex-wrap items-center justify-between gap-[12px]">
          <button type="button" className="secondary-button shrink-0 max-[560px]:flex-1" onClick={() => setPath(settings?.defaultSessionsDir || '')} disabled={!settings || saving || !showDefaultHint}>使用默认目录</button>
          <button type="submit" className="primary-button shrink-0 max-[560px]:flex-1" disabled={!settings || saving}>{saving && <LoaderCircle size={14} className="spin" />}{saving ? '保存中…' : '保存并重新索引'}</button>
        </div>
      </form>
      <p id="settings-description" className="mt-5 mb-0 text-[12px] leading-[1.8] text-(--muted)">日志仅在本机读取，所有数据保留在这台电脑。</p>
    </section>
  </div>;
}
