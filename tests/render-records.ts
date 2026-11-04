import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordWorkspace } from '../client/RecordInspector';

export function renderRecords(children: ReactNode) {
  return renderToStaticMarkup(createElement(RecordWorkspace, { scope: 'test', revision: 'revision', onNavigate() {}, children }));
}
