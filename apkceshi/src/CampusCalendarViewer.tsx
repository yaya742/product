import { useEffect, useRef, useState } from 'react';
import PdfWorker from './pdf.worker.compat.ts?worker';
import { installPdfCompatibility } from './runtime/pdfCompatibility';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { readOfficialCalendarPdf } from './runtime/campus';
import type { UiCopy } from './runtime/i18n';

interface CampusCalendarViewerProps {
  url: string;
  copy: UiCopy;
  onClose: () => void;
}

function CalendarPdfPage({ page, number }: { page: PDFPageProxy; number: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy['render']> | undefined;
    let lastWidth = 0;

    const render = async () => {
      const width = host.clientWidth;
      if (!width || width === lastWidth) return;
      lastWidth = width;
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: width / baseViewport.width });
        const outputScale = Math.max(1, window.devicePixelRatio || 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        canvas.setAttribute('aria-label', `PDF page ${number}`);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas is unavailable');
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        if (cancelled) return;
        host.replaceChildren(canvas);
        setError(false);
      } catch (cause) {
        if (!cancelled && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
          lastWidth = 0;
          setError(true);
        }
      }
    };

    void render();
    const resize = () => {
      if (host.clientWidth === lastWidth) return;
      renderTask?.cancel();
      void render();
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    if (observer) observer.observe(host);
    else window.addEventListener('resize', resize);
    return () => {
      cancelled = true;
      observer?.disconnect();
      if (!observer) window.removeEventListener('resize', resize);
      renderTask?.cancel();
      host.replaceChildren();
    };
  }, [page, number]);

  return <div className="campus-calendar-page" ref={hostRef}>{error && <p role="status">无法显示第 {number} 页。</p>}</div>;
}

export function CampusCalendarViewer({ url, copy, onClose }: CampusCalendarViewerProps) {
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const errorCopyRef = useRef(copy.campusCalendarError);
  errorCopyRef.current = copy.campusCalendarError;

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    setLoading(true);
    setError('');
    setPdfDocument(null);

    void (async () => {
      try {
        const data = await readOfficialCalendarPdf(url);
        if (cancelled) return;
        installPdfCompatibility();
        const pdfjs = await import('pdfjs-dist');
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerPort ??= new PdfWorker();
        loadingTask = pdfjs.getDocument({ data, enableXfa: false, useSystemFonts: true });
        const loaded = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }
        setPdfDocument(loaded);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : errorCopyRef.current);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [url, retryToken]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <section className="full-screen-panel campus-calendar-viewer" role="dialog" aria-modal="true" aria-label={copy.campusCalendarOpen}>
      <header className="secondary-topbar">
        <button className="back-button" type="button" onClick={onClose}><span aria-hidden="true">←</span><span>{copy.back}</span></button>
        <h2>{copy.campusCalendarOpen}</h2>
        <span className="topbar-spacer" />
      </header>
      <div className="campus-calendar-scroll">
        {loading && <p className="campus-calendar-message" role="status">{copy.campusCalendarLoading}</p>}
        {!loading && error && <div className="campus-calendar-message" role="alert"><p>{error || copy.campusCalendarError}</p><button type="button" className="secondary-button" onClick={() => setRetryToken((value) => value + 1)}>{copy.campusCalendarRetry}</button></div>}
        {!loading && !error && pdfDocument && (
          <div className="campus-calendar-pages">
            {Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1).map((number) => (
              <CalendarPage key={number} document={pdfDocument} number={number} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CalendarPage({ document, number }: { document: PDFDocumentProxy; number: number }) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  useEffect(() => {
    let cancelled = false;
    void document.getPage(number).then((loaded) => {
      if (!cancelled) setPage(loaded);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [document, number]);
  return page ? <CalendarPdfPage page={page} number={number} /> : <div className="campus-calendar-page-placeholder" aria-hidden="true" />;
}
