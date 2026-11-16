import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '../src/styles.css';
import { App } from '../src/App';
import { installDemo, demoEvent } from './state';
import './style.css';

installDemo();
createRoot(document.getElementById('root')!).render(<><App /><div className="website-demo-label">Interactive example · no live agents or local access</div></>);

const click = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim().startsWith(label) || button.getAttribute('aria-label') === label)?.click();
const close = () => document.querySelector<HTMLButtonElement>('.work-detail .detail-topbar button[aria-label*="Close"], .work-detail button[aria-label="Close work item"], .detail-topbar button[aria-label="Close"]')?.click();
const tabs = new Set(['conversation', 'artifacts', 'browser', 'terminal', 'changes', 'runbook']);
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'memcode-demo:guide') return;
  const step = event.data.step;
  if (step === 'ready') { demoEvent('ready'); return; }
  if (step === 'reset') { location.reload(); return; }
  if (step === 'create') { close(); click('New work item'); return; }
  if (['project', 'board', 'cycle', 'insights'].includes(step)) { close(); click(step === 'cycle' ? 'Cycles' : step === 'insights' ? 'Insights' : 'Workspace'); return; }
  if (step === 'story' || tabs.has(step)) {
    if (!document.querySelector('.detail-tabs')) document.querySelector<HTMLElement>('.work-card[aria-label^="MC-003"]')?.click();
    if (tabs.has(step)) setTimeout(() => {
      const name = step[0].toUpperCase() + step.slice(1);
      document.querySelectorAll<HTMLButtonElement>('.detail-tabs button').forEach((button) => { if (button.textContent?.trim().startsWith(name)) button.click(); });
    }, 50);
  }
});
document.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLElement>('.work-card,.detail-tabs button');
  if (target?.classList.contains('work-card')) demoEvent('story-opened', { storyId: target.getAttribute('aria-label')?.split(':')[0] });
  else if (target) demoEvent('tab-changed', { tab: target.textContent?.trim().toLowerCase() });
});
requestAnimationFrame(() => { demoEvent('ready'); parent.postMessage({ type: 'memcode-demo:size', width: 1512, height: 1000 }, location.origin); });
