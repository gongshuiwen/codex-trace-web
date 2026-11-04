import type { TurnDetail } from '../shared/types';
import type { CollaborationRecord } from './collaboration-data';
import { api, sessionPath } from './api';
import { turnDetailCache } from './turn-detail-cache';

export type CollaborationLocation = Pick<CollaborationRecord, 'sessionId' | 'turnId' | 'id' | 'messageType' | 'sender' | 'taskName'>;
export interface CollaborationDetail { payload: string; raw: string }

interface LoaderOptions {
  cache?: Pick<typeof turnDetailCache, 'get' | 'put'>;
  fetchTurn?: (sessionId: string, turnId: string, signal: AbortSignal) => Promise<TurnDetail>;
}

interface SharedRequest {
  controller: AbortController;
  subscribers: Set<symbol>;
  promise: Promise<TurnDetail>;
  settled: boolean;
}

const cancelled = () => new DOMException('协作消息读取已取消', 'AbortError');

function messageDetail(detail: TurnDetail, location: CollaborationLocation): CollaborationDetail {
  if (detail.summary.id !== location.turnId) throw new Error('读取到的轮次与消息来源不一致，请重新定位这条消息。');
  const event = detail.events.find(event => event.id === location.id);
  const message = event?.kind === 'collaboration' ? event.collaboration : undefined;
  if (!event || !message || message.messageType !== location.messageType || message.sender !== location.sender || message.taskName !== location.taskName) {
    throw new Error('未找到这条协作消息的完整正文，日志可能已变化。请重试或查看来源轮次。');
  }
  return { payload: message.payload, raw: event.text };
}

/** Share a turn request, while each expanded message keeps its own cancellation. */
export function createCollaborationDetailLoader({ cache = turnDetailCache, fetchTurn = (sessionId, turnId, signal) =>
  api<TurnDetail>(`${sessionPath(sessionId)}/turns/${encodeURIComponent(turnId)}`, { signal }),
}: LoaderOptions = {}) {
  const pending = new Map<string, SharedRequest>();
  const latest = new Map<string, SharedRequest>();

  return function loadCollaborationDetail(location: CollaborationLocation, revision: string, signal?: AbortSignal): Promise<CollaborationDetail> {
    if (signal?.aborted) return Promise.reject(cancelled());
    const cached = cache.get(location.sessionId, location.turnId);
    if (cached?.revision === revision) {
      try { return Promise.resolve(messageDetail(cached.data, location)); }
      catch { /* A cached turn without this exact message needs a fresh lookup. */ }
    }

    const key = JSON.stringify([location.sessionId, location.turnId, revision]);
    const turnKey = JSON.stringify([location.sessionId, location.turnId]);
    let request = pending.get(key);
    if (!request) {
      const controller = new AbortController();
      const shared: SharedRequest = { controller, subscribers: new Set(), settled: false, promise: undefined! };
      shared.promise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw cancelled();
        return fetchTurn(location.sessionId, location.turnId, controller.signal);
      }).then(detail => {
        if (controller.signal.aborted) throw cancelled();
        if (detail.summary.id !== location.turnId) throw new Error('读取到的轮次与消息来源不一致，请重新定位这条消息。');
        const current = cache.get(location.sessionId, location.turnId);
        // A slower old revision must not replace a newly loaded revision or an external cache update.
        if (latest.get(turnKey) === shared && (!current || current === cached || current.revision === revision)) {
          cache.put(location.sessionId, location.turnId, revision, detail);
        }
        return detail;
      }).finally(() => {
        shared.settled = true;
        if (pending.get(key) === shared) pending.delete(key);
        if (latest.get(turnKey) === shared) latest.delete(turnKey);
      });
      pending.set(key, shared);
      latest.set(turnKey, shared);
      request = shared;
    }

    const shared = request;
    return new Promise((resolve, reject) => {
      const subscriber = Symbol();
      let active = true;
      shared.subscribers.add(subscriber);
      function release() {
        signal?.removeEventListener('abort', abort);
        shared.subscribers.delete(subscriber);
        if (!shared.settled && shared.subscribers.size === 0) {
          if (pending.get(key) === shared) pending.delete(key);
          if (latest.get(turnKey) === shared) latest.delete(turnKey);
          shared.controller.abort();
        }
      }
      function abort() {
        if (!active) return;
        active = false;
        release();
        reject(cancelled());
      }
      signal?.addEventListener('abort', abort, { once: true });
      // Cover an abort that happened while subscribing as well as future abort events.
      if (signal?.aborted) { abort(); return; }
      shared.promise.then(detail => {
        if (!active) return;
        active = false;
        release();
        try { resolve(messageDetail(detail, location)); }
        catch (error) { reject(error); }
      }, error => {
        if (!active) return;
        active = false;
        release();
        reject(error);
      });
    });
  };
}

export const loadCollaborationDetail = createCollaborationDetailLoader();
