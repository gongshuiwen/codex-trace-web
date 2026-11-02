import { useEffect, useRef, useState } from 'react';
import { FolderOpen, LoaderCircle, X } from 'lucide-react';
import type { AppSettings } from '../shared/types';
import { api, errorMessage } from './api';

export function SettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const modal = useRef<HTMLElement>(null);
  useEffect(() => { const controller = new AbortController(); api<AppSettings>('/api/settings', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setSettings(value); setPath(value.sessionsDir); } }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); }); return () => controller.abort(); }, []);
  useEffect(() => { if (settings) input.current?.focus(); }, [settings]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!path.trim()) { setError('请输入会话日志目录'); return; }
    setSaving(true); setError('');
    try { await api<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify({ sessionsDir: path.trim() }) }); onSaved(); onClose(); } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={modal} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const items = Array.from(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><div className="modal-heading"><div><span className="eyebrow">PREFERENCES</span><h2 id="settings-title">读取你自己的会话</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭设置"><X size={18} /></button></div><p className="settings-description">选择本机 Codex 日志所在的目录。应用只读取日志，设置保存后会重新建立索引。</p><form onSubmit={event => void save(event)}><label className="field-label" htmlFor="sessions-directory"><FolderOpen size={15} />会话日志目录</label><input ref={input} id="sessions-directory" className="directory-input" value={path} onChange={event => setPath(event.target.value)} placeholder={settings ? settings.defaultSessionsDir : '正在读取设置…'} disabled={!settings || saving} /><p className="field-hint">默认目录：{settings?.defaultSessionsDir || '加载中…'}</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setPath(settings?.defaultSessionsDir || '')} disabled={!settings || saving}>使用默认目录</button><button type="submit" className="primary-button" disabled={!settings || saving}>{saving && <LoaderCircle size={14} className="spin" />}{saving ? '保存中…' : '保存并重新索引'}</button></div></form></section></div>;
}
