import { lazy, Suspense } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImageOff } from 'lucide-react';

const CodeBlock = lazy(() => import('./CodeBlock'));
const supported = new Set(['javascript', 'typescript', 'json', 'bash', 'python']);

const markdownComponents: Components = {
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span className="image-placeholder"><ImageOff size={15} />{alt || '图片引用'}<small>仅显示引用，未读取图片</small></span>,
    code: ({ className, children, ...props }) => {
      const match = /language-([^\s]+)/.exec(className || '');
      const language = match?.[1] === 'ts' || match?.[1] === 'tsx' ? 'typescript' : match?.[1] === 'js' || match?.[1] === 'jsx' ? 'javascript' : match?.[1] === 'sh' || match?.[1] === 'shell' ? 'bash' : match?.[1] === 'py' ? 'python' : match?.[1];
      const value = String(children).replace(/\n$/, '');
      if (language && supported.has(language)) return <Suspense fallback={<code>{value}</code>}><CodeBlock language={language} value={value} /></Suspense>;
      return <code className={className} {...props}>{children}</code>;
    },
};

export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown></div>;
}
