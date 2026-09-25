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

const MIN_CALENDAR_ZOOM = 0.75;
const MAX_CALENDAR_ZOOM = 3;
const CALENDAR_ZOOM_STEP = 0.25;

function clampCalendarZoom(value: number): number {
  return Math.min(MAX_CALENDAR_ZOOM, Math.max(MIN_CALENDAR_ZOOM, value));
}

function getTouchDistance(touches: TouchList): number {
  const first = touches.item(0);
  const second = touches.item(1);
  if (!first || !second) return 0;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function CalendarPdfPage({ page, number, zoom }: { page: PDFPageProxy; number: number; zoom: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const scroller = host.closest('.campus-calendar-scroll');
    const observer = new IntersectionObserver(([entry]) => {
      if (scroller?.getAttribute('data-calendar-zooming') === 'true') return;
      setNearViewport(entry?.isIntersecting ?? false);
    }, {
      root: scroller,
      rootMargin: '800px 0px',
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !nearViewport) return;
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
        const requestedOutputScale = Math.min(2, window.devicePixelRatio || 1);
        const pixelBudgetScale = Math.sqrt(12_000_000 / (viewport.width * viewport.height));
        const outputScale = Math.min(requestedOutputScale, pixelBudgetScale);
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
  }, [page, number, nearViewport, zoom]);

  const viewport = page.getViewport({ scale: 1 });
  return <div className="campus-calendar-page" ref={hostRef} style={{ width: `${zoom * 100}%`, aspectRatio: `${viewport.width} / ${viewport.height}` }}>{error && <p role="status">无法显示第 {number} 页。</p>}</div>;
}

export function CampusCalendarViewer({ url, copy, onClose }: CampusCalendarViewerProps) {
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [renderZoom, setRenderZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  const renderZoomRef = useRef(renderZoom);
  zoomRef.current = zoom;
  renderZoomRef.current = renderZoom;
  const pinchRef = useRef<{ startDistance: number; startZoom: number; lastZoom: number } | null>(null);
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
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
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

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const startPinch = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        pinchRef.current = null;
        scrollRef.current?.removeAttribute('data-calendar-zooming');
        if (pagesRef.current) pagesRef.current.style.transform = '';
        return;
      }
      scrollRef.current?.setAttribute('data-calendar-zooming', 'true');
      pinchRef.current = {
        startDistance: getTouchDistance(event.touches),
        startZoom: zoomRef.current,
        lastZoom: zoomRef.current,
      };
    };
    const movePinch = (event: TouchEvent) => {
      const pinch = pinchRef.current;
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      if (!pinch.startDistance) return;
      const rawZoom = pinch.startZoom * getTouchDistance(event.touches) / pinch.startDistance;
      const nextZoom = Math.round(clampCalendarZoom(rawZoom) * 10) / 10;
      if (Math.abs(nextZoom - pinch.lastZoom) < 0.09) return;
      pinch.lastZoom = nextZoom;
      if (pagesRef.current) {
        pagesRef.current.style.transform = `scale(${nextZoom / pinch.startZoom})`;
        pagesRef.current.style.transformOrigin = 'top left';
      }
      setZoom(nextZoom);
    };
    const endPinch = (event: TouchEvent) => {
      if (event.touches.length >= 2 || !pinchRef.current) return;
      const finalZoom = pinchRef.current.lastZoom;
      pinchRef.current = null;
      setZoom(finalZoom);
      if (finalZoom !== renderZoomRef.current) setRenderZoom(finalZoom);
      requestAnimationFrame(() => {
        if (pagesRef.current) pagesRef.current.style.transform = '';
        scrollRef.current?.removeAttribute('data-calendar-zooming');
      });
    };

    scroller.addEventListener('touchstart', startPinch, { passive: true });
    scroller.addEventListener('touchmove', movePinch, { passive: false });
    scroller.addEventListener('touchend', endPinch, { passive: true });
    scroller.addEventListener('touchcancel', endPinch, { passive: true });
    return () => {
      scroller.removeEventListener('touchstart', startPinch);
      scroller.removeEventListener('touchmove', movePinch);
      scroller.removeEventListener('touchend', endPinch);
      scroller.removeEventListener('touchcancel', endPinch);
      pinchRef.current = null;
      scroller.removeAttribute('data-calendar-zooming');
    };
  }, []);

  useEffect(() => {
    if (zoom <= 1 && scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, [zoom]);

  const changeZoom = (amount: number) => {
    const next = Math.round(clampCalendarZoom(zoom + amount) * 100) / 100;
    setZoom(next);
    setRenderZoom(next);
    if (pagesRef.current) pagesRef.current.style.transform = '';
  };

  const fitWidth = () => {
    setZoom(1);
    setRenderZoom(1);
    if (pagesRef.current) pagesRef.current.style.transform = '';
  };

  return (
    <section className="full-screen-panel campus-calendar-viewer" role="dialog" aria-modal="true" aria-label={copy.campusCalendarOpen}>
      <header className="secondary-topbar">
        <button className="back-button" type="button" onClick={onClose}><span aria-hidden="true">←</span><span>{copy.back}</span></button>
        <h2>{copy.campusCalendarOpen}</h2>
        <span className="topbar-spacer" />
      </header>
      <div className="campus-calendar-zoom-toolbar" role="toolbar" aria-label={copy.campusCalendarZoom}>
        <button type="button" className="campus-calendar-zoom-button" aria-label={copy.campusCalendarZoomOut} disabled={zoom <= MIN_CALENDAR_ZOOM} onClick={() => changeZoom(-CALENDAR_ZOOM_STEP)}>−</button>
        <output className="campus-calendar-zoom-value" aria-live="polite">{Math.round(zoom * 100)}%</output>
        <button type="button" className="campus-calendar-zoom-button" aria-label={copy.campusCalendarZoomIn} disabled={zoom >= MAX_CALENDAR_ZOOM} onClick={() => changeZoom(CALENDAR_ZOOM_STEP)}>+</button>
        <button type="button" className="campus-calendar-fit-button" onClick={fitWidth} disabled={zoom === 1}>{copy.campusCalendarFitWidth}</button>
        <span className="campus-calendar-pinch-hint">{copy.campusCalendarPinchHint}</span>
      </div>
      <div className="campus-calendar-scroll" ref={scrollRef}>
        {loading && <p className="campus-calendar-message" role="status">{copy.campusCalendarLoading}</p>}
        {!loading && error && <div className="campus-calendar-message" role="alert"><p>{error || copy.campusCalendarError}</p><button type="button" className="secondary-button" onClick={() => setRetryToken((value) => value + 1)}>{copy.campusCalendarRetry}</button></div>}
        {!loading && !error && pdfDocument && (
          <div className="campus-calendar-pages" ref={pagesRef} data-zoomed={renderZoom > 1 ? 'true' : 'false'}>
            {Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1).map((number) => (
              <CalendarPage key={number} document={pdfDocument} number={number} zoom={renderZoom} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CalendarPage({ document, number, zoom }: { document: PDFDocumentProxy; number: number; zoom: number }) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  useEffect(() => {
    let cancelled = false;
    void document.getPage(number).then((loaded) => {
      if (!cancelled) setPage(loaded);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [document, number]);
  return page
    ? <CalendarPdfPage page={page} number={number} zoom={zoom} />
    : <div className="campus-calendar-page-placeholder" aria-hidden="true" style={{ width: `${zoom * 100}%` }} />;
}
