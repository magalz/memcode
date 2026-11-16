import { ArrowLeft, FileText, ShieldCheck } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { designImage, report } from './state';
import { DemoPage } from './Browser';

export function ArtifactPreview({ artifact, file, onBack }: any) {
  const name = artifact?.name ?? file?.name ?? 'implementation-report.md';
  return <section className="artifact-preview" aria-label="Artifact preview"><header className="artifact-preview-header"><button className="text-button" onClick={onBack}><ArrowLeft size={13}/>All artifacts</button><span className="artifact-preview-divider"/><FileText size={16}/><div><strong>{name}</strong><small>Saved example output</small></div><span className="artifact-format-tag">{name.endsWith('.md') ? 'Markdown' : name.endsWith('.svg') ? 'Image' : 'Interactive HTML'}</span></header><div className="artifact-preview-content demo-document-content">{name.endsWith('.svg') ? <img src={designImage} alt="Lumen example design output"/> : name.endsWith('.html') ? <DemoPage/> : <article className="artifact-document demo-report"><ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown></article>}</div><footer className="artifact-preview-footer"><ShieldCheck size={11}/>Saved output · example content<span>Rendered directly, separate from the live browser</span></footer></section>;
}
