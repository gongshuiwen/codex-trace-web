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
        <h2 id="settings-title" className="m-0 text-[20px] leading-[1.4] font-semibold max-[560px]:text-[18px]">读取你自己的会话</h2>
        <button ref={close} className="icon-button inline-flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[6px] border-0 bg-transparent text-(--muted) hover:bg-(--hover) hover:text-(--text) max-[560px]:h-[44px] max-[560px]:w-[44px]" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
      </div>
      <p id="settings-description" className="settings-description mt-[16px] mb-[24px] text-[12px] leading-[1.8] text-(--muted)">选择本机 Codex 日志所在的目录。应用只读取日志，设置保存后会重新建立索引。</p>
      <form onSubmit={event => void save(event)} className="min-w-0">
        <label className="field-label mb-[8px] flex items-center gap-[8px] text-[14px] font-medium text-(--soft)" htmlFor="sessions-directory"><FolderOpen size={15} />会话日志目录</label>
        <input ref={input} id="sessions-directory" className="directory-input block h-[40px] w-full min-w-0 rounded-[6px] border border-(--control) bg-(--bg) px-[12px] font-mono text-[12px] text-(--text) outline-offset-[3px] placeholder:text-(--muted) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:cursor-default disabled:opacity-60 max-[560px]:h-[44px]" value={path} onChange={event => setPath(event.target.value)} placeholder={settings ? settings.defaultSessionsDir : '正在读取设置…'} aria-describedby={`directory-hint${error ? ' settings-error' : ''}`} disabled={!settings || saving} />
        <p id="directory-hint" className="field-hint mt-[8px] mb-0 text-[12px] leading-[1.8] text-(--muted) [overflow-wrap:anywhere]">默认目录：{settings?.defaultSessionsDir || '加载中…'}</p>
        {error && <p id="settings-error" className="inline-error mt-[12px] mb-0 rounded-[6px] border border-(--danger)/25 bg-(--bg) p-[12px] text-[12px] leading-[1.8] text-(--danger) [overflow-wrap:anywhere]" role="alert">{error}</p>}
        <div className="modal-actions mt-[24px] flex flex-wrap items-center justify-between gap-[12px]">
          <button type="button" className="secondary-button inline-flex h-[36px] shrink-0 items-center justify-center gap-[6px] rounded-[6px] border border-(--control) bg-(--panel) px-[12px] text-[12px] text-(--soft) hover:bg-(--hover) disabled:cursor-default disabled:opacity-60 max-[560px]:h-[44px] max-[560px]:flex-1" onClick={() => setPath(settings?.defaultSessionsDir || '')} disabled={!settings || saving}>使用默认目录</button>
          <button type="submit" className="primary-button inline-flex h-[36px] shrink-0 items-center justify-center gap-[6px] rounded-[6px] border border-(--accent-strong) bg-(--accent-strong) px-[12px] text-[12px] text-(--panel) hover:bg-(--accent) disabled:cursor-default disabled:opacity-60 max-[560px]:h-[44px] max-[560px]:flex-1" disabled={!settings || saving}>{saving && <LoaderCircle size={14} className="spin" />}{saving ? '保存中…' : '保存并重新索引'}</button>
        </div>
      </form>
    </section>
  </div>;
}
