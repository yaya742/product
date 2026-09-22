import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Browser } from '@capacitor/browser';
import { MapPanel } from './MapPanel';
import { WeatherPanel } from './WeatherPanel';
import { runMobileAgent, type AgentStatus } from './runtime/agent';
import { completeDeepSeek, DeepSeekError, testDeepSeekConnection, translateText } from './runtime/deepseek';
import { CampusError, currentAcademicTerm, readCampusInfo, readLearningActivities, readPublicCollegeInfo, readPublicNotices, type CampusPublicInfoResult } from './runtime/campus';
import { getUiCopy } from './runtime/i18n';
import { cancelLocalReminder, scheduleLocalReminder, withNotificationId } from './runtime/reminders';
import { clearMobileState, hydrateMobileSecrets, loadMobileState, saveMobileState } from './runtime/storage';
import { isMobileVmSession, launchMobileVm } from './runtime/mobileVm';
import {
  createConversation,
  createInitialState,
  newId,
  type CampusPublicCategory,
  type CampusNotice,
  type MobileAgendaItem,
  type MobileAttachment,
  type MobileConversation,
  type MobileLanguage,
  type MobileMessage,
  type MobileProfile,
  type MobileReminder,
  type MobileState,
  type MobileTurnControls,
  type MobileTheme,
} from './runtime/types';

const DEFAULT_TURN_CONTROLS: MobileTurnControls = {
  memoryMode: 'relevant',
  retention: 'purpose_scoped',
  audience: 'self',
};

const CAMPUS_WEBVPN_URL = 'https://webvpn.zju.edu.cn/';

function friendlyError(error: unknown): string {
  if (error instanceof DeepSeekError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return '本轮已停止。';
  if (error instanceof Error) return error.message;
  return '这次处理中断了，请稍后重试。';
}

function formatTime(value: string, language: MobileLanguage): string {
  const locale = language === 'en' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatHistoryDate(value: string, language: MobileLanguage): string {
  const locale = language === 'en' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(value));
}

function compactTitle(value: string, fallback: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').replace(/^\s*["“”'‘’]+|["“”'‘’]+\s*$/g, '').trim();
  return (clean || fallback).slice(0, 28);
}

function localDateTimeValue(value = new Date(Date.now() + 60 * 60 * 1000)): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function formatReminderDate(value: string, language: MobileLanguage): string {
  const locale = language === 'en' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatCampusUpdated(value: string, language: MobileLanguage): string {
  const locale = language === 'en' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function Avatar({ value, className }: { value: string; className: string }) {
  const image = /^data:image\//i.test(value);
  return <span className={className}>{image ? <img className="avatar-image" src={value} alt="" /> : (value || '在')}</span>;
}

function inlineMarkdown(value: string): ReactNode {
  const safe = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return safe.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((piece, index) => {
    if (piece.startsWith('**') && piece.endsWith('**')) return <strong key={index}>{piece.slice(2, -2)}</strong>;
    if (piece.startsWith('`') && piece.endsWith('`')) return <code key={index}>{piece.slice(1, -1)}</code>;
    return <span key={index}>{piece}</span>;
  });
}

function messageLinkLabel(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname === 'person.zju.edu.cn') return '打开教师主页';
    if (hostname === 'www.zju.edu.cn' || hostname.endsWith('.zju.edu.cn')) return '打开官方页面';
    return '打开链接';
  } catch {
    return '打开链接';
  }
}

function messageTableCell(value: string): ReactNode {
  const candidate = value.trim();
  if (/^https:\/\/[^\s|]+$/i.test(candidate)) {
    return (
      <a
        className="message-link"
        href={candidate}
        title={candidate}
        onClick={(event) => {
          event.preventDefault();
          void Browser.open({ url: candidate }).catch(() => window.open(candidate, '_blank', 'noopener,noreferrer'));
        }}
      >
        {messageLinkLabel(candidate)}
      </a>
    );
  }
  return inlineMarkdown(value);
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function MessageContent({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].trim().startsWith('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = tableCells(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push(
        <div className="message-table-wrap" key={`table-${index}`}>
          <table className="message-table">
            <thead><tr>{headers.map((header, cellIndex) => <th key={cellIndex}>{inlineMarkdown(header)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{messageTableCell(row[cellIndex] || '')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const line = lines[index];
    if (!line.trim()) {
      blocks.push(<div className="message-line-break" key={`blank-${index}`} />);
    } else if (/^#{1,3}\s/.test(line)) {
      blocks.push(<h4 key={index}>{inlineMarkdown(line.replace(/^#{1,3}\s/, ''))}</h4>);
    } else if (/^[-*]\s+/.test(line)) {
      blocks.push(<div className="message-list-item" key={index}>• {inlineMarkdown(line.replace(/^[-*]\s+/, ''))}</div>);
    } else {
      blocks.push(<p key={index}>{inlineMarkdown(line)}</p>);
    }
    index += 1;
  }
  return <div className="message-content">{blocks}</div>;
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6.5h14M5 12h14M5 17.5h9" />
      <path d="M3.5 6.5h.01M3.5 12h.01M3.5 17.5h.01" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3.5 6.2 5.7-2.4 5.6 2.4 5.7-2.4v14.2L14.8 20l-5.6-2.2-5.7 2.2V6.2Z" />
      <path d="M9.2 3.8v14M14.8 6.2v13.8" />
    </svg>
  );
}

function WeatherIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 18.2h10.2a3.3 3.3 0 0 0 .2-6.6 5.7 5.7 0 0 0-10.8-1.1A3.9 3.9 0 0 0 7 18.2Z" />
      <path d="M8 21v-1.4M12 21v-1.4M16 21v-1.4" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="m19.4 13.5 1.1.9-1.7 2.9-1.4-.5a7.7 7.7 0 0 1-1.4.8l-.3 1.5h-3.4l-.3-1.5a7.7 7.7 0 0 1-1.4-.8l-1.4.5-1.7-2.9 1.1-.9a7.1 7.1 0 0 1 0-1.6l-1.1-.9 1.7-2.9 1.4.5a7.7 7.7 0 0 1 1.4-.8l.3-1.5h3.4l.3 1.5a7.7 7.7 0 0 1 1.4.8l1.4-.5 1.7 2.9-1.1.9a7.1 7.1 0 0 1 0 1.6Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m15 5-7 7 7 7M8 12h11" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 14 6-6 6 6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 10 6 6 6-6" />
    </svg>
  );
}

function AttachmentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m20.2 11.2-7.7 7.7a5 5 0 0 1-7.1-7.1l8.1-8.1a3.4 3.4 0 0 1 4.8 4.8l-8.2 8.2a1.8 1.8 0 0 1-2.6-2.6l7.5-7.5" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 9.5a6 6 0 0 0-12 0c0 7-3 7-3 8.5h18c0-1.5-3-1.5-3-8.5ZM10 21h4" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5 19 6v5.1c0 4.2-2.6 7.8-7 9.4-4.4-1.6-7-5.2-7-9.4V6l7-2.5Z" />
      <path d="m8.8 12 2.1 2.1 4.4-4.4" />
    </svg>
  );
}

export function App() {
  const initial = useMemo(() => loadMobileState(), []);
  const [state, setState] = useState<MobileState>(initial);
  const [secretsHydrated, setSecretsHydrated] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachmentDraft, setAttachmentDraft] = useState<MobileAttachment | null>(null);
  const [attachmentMessage, setAttachmentMessage] = useState('');
  const [memoryDraft, setMemoryDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [turnControls, setTurnControls] = useState<MobileTurnControls>(DEFAULT_TURN_CONTROLS);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [, setStatus] = useState<AgentStatus | '空闲'>('空闲');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [dataMessage, setDataMessage] = useState('');
  const [translationMessage, setTranslationMessage] = useState('');
  const [translating, setTranslating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyMenuId, setHistoryMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [campusOpen, setCampusOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [reminderTitleDraft, setReminderTitleDraft] = useState('');
  const [reminderNotesDraft, setReminderNotesDraft] = useState('');
  const [reminderTimeDraft, setReminderTimeDraft] = useState(() => localDateTimeValue());
  const [reminderMessage, setReminderMessage] = useState('');
  const [mapOpen, setMapOpen] = useState(false);
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState('');
  const [campusSaved, setCampusSaved] = useState(false);
  const [campusLoading, setCampusLoading] = useState(false);
  const [campusMessage, setCampusMessage] = useState('');
  const campusWebVpnAutoOpenedRef = useRef(false);
  const initialAcademicTerm = currentAcademicTerm();
  const [campusTab, setCampusTab] = useState<'overview' | 'schedule' | 'courses' | 'learning' | 'activities' | 'exams' | 'grades' | 'gpa' | 'todos' | 'practice' | 'holidays' | 'notices' | 'public'>('overview');
  const [campusAcademicYear, setCampusAcademicYear] = useState(initialAcademicTerm.year);
  const [campusTerm, setCampusTerm] = useState(initialAcademicTerm.term);
  const [noticeQuery, setNoticeQuery] = useState('');
  const [notices, setNotices] = useState<CampusNotice[]>([]);
  const [noticesPage, setNoticesPage] = useState(1);
  const [noticesTotal, setNoticesTotal] = useState(0);
  const [noticesLoading, setNoticesLoading] = useState(false);
  const [noticesMessage, setNoticesMessage] = useState('');
  const [publicQuery, setPublicQuery] = useState('');
  const [publicCategory, setPublicCategory] = useState<CampusPublicCategory>('all');
  const [publicInfo, setPublicInfo] = useState<CampusPublicInfoResult | null>(null);
  const [publicLoading, setPublicLoading] = useState(false);
  const [publicMessage, setPublicMessage] = useState('');
  const [scrollState, setScrollState] = useState({ canUp: false, canDown: false });
  const abortRef = useRef<AbortController | undefined>(undefined);
  const translationAbortRef = useRef<AbortController | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const copy = getUiCopy(state.profile.language);
  const campusTermLabel = (term: string) => term === '1' ? copy.campusAutumnTerm : copy.campusSpringTerm;
  const activeConversation = state.conversations.find((item) => item.id === state.activeConversationId) || state.conversations[0];
  const messages = activeConversation?.messages || [];
  // Empty drafts are not history items, so repeated new-chat taps stay out of history.
  const sortedConversations = state.conversations
    .filter((conversation) => conversation.messages.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visibleConversations = historyQuery.trim()
    ? sortedConversations.filter((conversation) => `${conversation.title} ${conversation.messages.map((message) => message.content).join(' ')}`.toLowerCase().includes(historyQuery.trim().toLowerCase()))
    : sortedConversations;

  useEffect(() => {
    void hydrateMobileSecrets(initial).then((next) => {
      setState(next);
      setSecretsHydrated(true);
    });
  }, [initial]);

  useEffect(() => {
    if (secretsHydrated) saveMobileState(state);
  }, [secretsHydrated, state]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const updateScrollState = () => {
      setScrollState({
        canUp: node.scrollTop > 16,
        canDown: node.scrollTop + node.clientHeight < node.scrollHeight - 16,
      });
    };
    updateScrollState();
    node.addEventListener('scroll', updateScrollState, { passive: true });
    return () => node.removeEventListener('scroll', updateScrollState);
  }, [messages]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateKeyboardHeight = () => {
      const visibleBottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
      const keyboardHeight = Math.max(0, window.innerHeight - visibleBottom);
      document.documentElement.style.setProperty('--keyboard-height', `${Math.round(keyboardHeight)}px`);
    };
    updateKeyboardHeight();
    viewport?.addEventListener('resize', updateKeyboardHeight);
    viewport?.addEventListener('scroll', updateKeyboardHeight);
    window.addEventListener('resize', updateKeyboardHeight);
    window.addEventListener('focusin', updateKeyboardHeight);
    window.addEventListener('focusout', updateKeyboardHeight);
    return () => {
      viewport?.removeEventListener('resize', updateKeyboardHeight);
      viewport?.removeEventListener('scroll', updateKeyboardHeight);
      window.removeEventListener('resize', updateKeyboardHeight);
      window.removeEventListener('focusin', updateKeyboardHeight);
      window.removeEventListener('focusout', updateKeyboardHeight);
      document.documentElement.style.removeProperty('--keyboard-height');
    };
  }, []);

  function updateState(partial: Partial<MobileState>) {
    setState((current) => ({ ...current, ...partial }));
  }

  function updateProfile(partial: Partial<MobileProfile>) {
    setState((current) => ({ ...current, profile: { ...current.profile, ...partial } }));
  }

  function campusErrorMessage(error: unknown): string {
    if (error instanceof CampusError) return error.message;
    return state.profile.language === 'en' ? 'Campus information could not be loaded. Please try again.' : state.profile.language === 'zh-TW' ? '無法讀取校園資訊，請稍後再試。' : '暂时无法读取校园信息，请稍后重试。';
  }

  async function openCampusWebVpn(options: { auto?: boolean } = {}) {
    if (options.auto) {
      if (campusWebVpnAutoOpenedRef.current) return;
      campusWebVpnAutoOpenedRef.current = true;
    }
    try {
      await Browser.open({ url: CAMPUS_WEBVPN_URL });
    } catch {
      window.open(CAMPUS_WEBVPN_URL, '_blank', 'noopener,noreferrer');
    }
  }

  async function refreshCampusInfo() {
    if (campusLoading) return;
    if (!state.profile.studentId.trim() || !state.profile.studentPassword) {
      setCampusMessage(copy.campusNeedCredentials);
      return;
    }
    setCampusLoading(true);
    setCampusSaved(false);
    // Do not keep rendering a previous term while a new read is in flight.
    // A failed refresh must never leave an old schedule labelled as the
    // currently selected academic year and term.
    updateState({ campus: null });
    setCampusMessage(copy.campusLoading);
    try {
      const campus = await readCampusInfo(state.profile.studentId, state.profile.studentPassword, { academicYear: campusAcademicYear, term: campusTerm });
      updateState({ campus });
      setCampusAcademicYear(campus.academicYear);
      setCampusTerm(campus.term);
      setCampusSaved(true);
      const hasNetworkWarning = campus.warnings.some((warning) => /VPN|WebVPN|校内网络|校外网络/i.test(warning));
      setCampusMessage(hasNetworkWarning ? `${copy.campusPartial} ${copy.campusWebVpnOpened}` : campus.warnings.length ? copy.campusPartial : copy.campusUpdated);
      if (hasNetworkWarning) void openCampusWebVpn({ auto: true });
    } catch (error) {
      const networkRestricted = error instanceof CampusError && error.code === 'network';
      setCampusMessage(networkRestricted ? `${campusErrorMessage(error)} ${copy.campusWebVpnOpened}` : campusErrorMessage(error));
      if (networkRestricted) void openCampusWebVpn({ auto: true });
    } finally {
      setCampusLoading(false);
    }
  }

  async function refreshNotices(query = noticeQuery, page = 1) {
    if (noticesLoading) return;
    setNoticesLoading(true);
    setNoticesMessage(copy.campusNoticeLoading);
    try {
      const result = await readPublicNotices(query, page);
      setNotices(result.notices);
      setNoticesPage(result.page);
      setNoticesTotal(result.totalAvailable);
      setNoticesMessage(result.notices.length ? '' : copy.campusNoticeEmpty);
    } catch (error) {
      setNoticesMessage(campusErrorMessage(error));
    } finally {
      setNoticesLoading(false);
    }
  }

  async function refreshPublicInfo(query = publicQuery, category = publicCategory) {
    if (publicLoading) return;
    setPublicLoading(true);
    setPublicMessage(copy.campusPublicLoading);
    try {
      const result = await readPublicCollegeInfo(query, category);
      setPublicInfo(result);
      setPublicMessage(result.results.length ? '' : copy.campusPublicEmpty);
    } catch (error) {
      setPublicMessage(campusErrorMessage(error));
    } finally {
      setPublicLoading(false);
    }
  }

  async function openNoticeInBrowser(url: string) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'zdbk.zju.edu.cn') return;
      await Browser.open({ url: parsed.toString() });
    } catch {
      // Browser.open is unavailable in a browser preview; keep a web fallback.
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  async function openPublicInfoInBrowser(url: string) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !(parsed.hostname.toLowerCase() === 'person.zju.edu.cn' || parsed.hostname.toLowerCase() === 'www.zju.edu.cn' || parsed.hostname.toLowerCase().endsWith('.zju.edu.cn'))) return;
      await Browser.open({ url: parsed.toString() });
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  function selectCampusTab(tab: 'overview' | 'schedule' | 'courses' | 'learning' | 'activities' | 'exams' | 'grades' | 'gpa' | 'todos' | 'practice' | 'holidays' | 'notices' | 'public') {
    setCampusTab(tab);
    if (tab === 'notices' && !notices.length && !noticesLoading) void refreshNotices('', 1);
  }

  async function handleAvatarFile(file: File) {
    const failedMessage = state.profile.language === 'en' ? 'Please choose a valid image.' : state.profile.language === 'zh-TW' ? '請選擇有效的圖片。' : '请选择有效的图片。';
    if (!file.type.startsWith('image/')) {
      setAvatarMessage(failedMessage);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(failedMessage));
        element.src = objectUrl;
      });
      const size = Math.min(image.naturalWidth, image.naturalHeight);
      if (!size) throw new Error(failedMessage);
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(failedMessage);
      context.fillStyle = '#eef4ed';
      context.fillRect(0, 0, 256, 256);
      context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 256, 256);
      updateProfile({ avatar: canvas.toDataURL('image/jpeg', 0.86) });
      setAvatarMessage('');
    } catch (error) {
      setAvatarMessage(error instanceof Error ? error.message : failedMessage);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function handleAttachmentFile(file: File) {
    setAttachmentMessage('');
    const isText = file.type.startsWith('text/') || /\.(txt|md|json|csv|log)$/i.test(file.name);
    const isImage = file.type.startsWith('image/');
    if (!isText && !isImage) {
      setAttachmentMessage(copy.attachmentInvalid);
      return;
    }
    try {
      if (isText) {
        const text = await file.text();
        if (!text.trim() || text.length > 20_000) {
          setAttachmentMessage(copy.attachmentTooLarge);
          return;
        }
        setAttachmentDraft({ kind: 'text', name: file.name.slice(0, 160), text });
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error(copy.attachmentInvalid));
          element.src = objectUrl;
        });
        const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error(copy.attachmentInvalid);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        let quality = .82;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > 1_800_000 && quality > .48) {
          quality -= .08;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        if (dataUrl.length > 1_800_000) {
          setAttachmentMessage(copy.attachmentTooLarge);
          return;
        }
        setAttachmentDraft({ kind: 'image', name: file.name.slice(0, 160), mimeType: 'image/jpeg', dataUrl, width, height });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (error) {
      setAttachmentMessage(error instanceof Error ? error.message : copy.attachmentInvalid);
    }
  }

  async function changeLanguage(language: MobileLanguage) {
    const previousLanguage = state.profile.language;
    if (language === previousLanguage || translating || busy) return;
    const targetCopy = getUiCopy(language);
    const conversationId = activeConversation?.id;
    const currentMessages = messages;
    updateProfile({ language });
    setTranslationMessage('');
    if (!conversationId || !currentMessages.length) return;
    if (!state.apiKey.trim()) {
      setTranslationMessage(targetCopy.translationNeedKey);
      return;
    }

    translationAbortRef.current?.abort();
    const controller = new AbortController();
    translationAbortRef.current = controller;
    setTranslating(true);
    setTranslationMessage(targetCopy.translatingConversation);
    setState((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) => conversation.id !== conversationId ? conversation : {
        ...conversation,
        messages: conversation.messages.map((message) => ({
          ...message,
          translations: { ...message.translations, [previousLanguage]: message.translations?.[previousLanguage] ?? message.content },
        })),
      }),
    }));

    let failed = false;
    try {
      for (const message of currentMessages) {
        controller.signal.throwIfAborted();
        const cached = message.translations?.[language];
        const translated = cached || await translateText(state.apiKey, message.content, language, controller.signal);
        setState((current) => ({
          ...current,
          conversations: current.conversations.map((conversation) => conversation.id !== conversationId ? conversation : {
            ...conversation,
            messages: conversation.messages.map((item) => item.id !== message.id ? item : {
              ...item,
              content: translated,
              translations: {
                ...item.translations,
                [previousLanguage]: item.translations?.[previousLanguage] ?? item.content,
                [language]: translated,
              },
            }),
          }),
        }));
      }
    } catch (error) {
      if (!controller.signal.aborted) failed = true;
    } finally {
      if (!controller.signal.aborted) setTranslationMessage(failed ? targetCopy.translationFailed : targetCopy.translatedConversation);
      if (translationAbortRef.current === controller) translationAbortRef.current = undefined;
      setTranslating(false);
    }
  }

  function updateActiveConversation(change: (conversation: MobileConversation) => MobileConversation) {
    setState((current) => ({
      ...current,
      conversations: current.conversations.map((item) => item.id === current.activeConversationId ? change(item) : item),
    }));
  }

  function updateActiveMessages(change: (messages: MobileMessage[]) => MobileMessage[]) {
    updateActiveConversation((conversation) => ({
      ...conversation,
      messages: change(conversation.messages),
      updatedAt: new Date().toISOString(),
    }));
  }

  async function generateConversationTitle(conversationId: string, apiKey: string, userText: string) {
    const fallback = compactTitle(userText, copy.titleFallback);
    let title = fallback;
    try {
      const completion = await completeDeepSeek(
        apiKey,
        [
          { role: 'system', content: '请把用户的话总结成一个简短的中文对话标题。只返回标题，不要引号，不超过 16 个字。' },
          { role: 'user', content: userText },
        ],
        AbortSignal.timeout(15_000),
        [],
      );
      title = compactTitle(typeof completion.message.content === 'string' ? completion.message.content : '', fallback);
    } catch {
      title = fallback;
    }
    setState((current) => ({
      ...current,
      conversations: current.conversations.map((item) => item.id === conversationId ? { ...item, title } : item),
    }));
  }

  async function send() {
    const text = draft.trim();
    const attachment = attachmentDraft;
    if ((!text && !attachment) || busy) return;
    if (!state.apiKey.trim()) {
      setHistoryOpen(false);
      setProfileOpen(false);
      setConnectionMessage(copy.needKey);
      setProfileOpen(true);
      return;
    }
    const conversationId = activeConversation.id;
    const history = messages;
    const conversationLanguage = state.profile.language;
    const controls = turnControls;
    const ephemeral = controls.retention === 'session_only';
    const shouldGenerateTitle = history.length === 0 && !ephemeral;
    const userMessage: MobileMessage = {
      id: newId('user'),
      role: 'user',
      content: text || (attachment?.kind === 'image' ? copy.imageReady : copy.textAttachmentReady),
      ...(attachment ? { attachment } : {}),
      translations: { [conversationLanguage]: text || (attachment?.kind === 'image' ? copy.imageReady : copy.textAttachmentReady) },
      ...(ephemeral ? { ephemeral: true } : {}),
      createdAt: new Date().toISOString(),
      status: 'done',
    };
    const assistantId = newId('assistant');
    const assistantMessage: MobileMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      translations: {},
      ...(ephemeral ? { ephemeral: true } : {}),
      createdAt: new Date().toISOString(),
      status: 'running',
    };
    setDraft('');
    setAttachmentDraft(null);
    setAttachmentMessage('');
    setBusy(true);
    setStatus('联系 DeepSeek');
    updateActiveMessages((current) => [...current, userMessage, assistantMessage]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runMobileAgent(
        state.apiKey,
        history,
        text,
        state.memories,
        conversationLanguage,
        controller.signal,
        (delta) => {
          updateActiveMessages((current) => current.map((message) =>
            message.id === assistantId ? { ...message, content: message.content + delta } : message,
          ));
        },
        setStatus,
        {
          conversations: state.conversations,
          agenda: state.agenda,
          reminders: state.reminders,
          controls,
          allowMemoryWrite: controls.retention === 'purpose_scoped' && controls.memoryMode === 'relevant',
          allowLocalWrites: controls.retention !== 'session_only',
          campus: state.campus,
          readLearningActivities: async (courseId) => readLearningActivities(state.profile.studentId, state.profile.studentPassword, courseId),
          currentAttachment: attachment || undefined,
          createReminder: createReminderRecord,
          prepareAction: createAgendaRecord,
          updateAction: updateAgendaRecord,
          saveMemory: async (memory) => {
            setState((current) => ({ ...current, memories: [...current.memories.filter((item) => item !== memory), memory].slice(-16) }));
            return { status: 'ok', saved: memory };
          },
        },
        controls,
      );
      updateActiveMessages((current) => current.map((message) =>
        message.id === assistantId ? {
          ...message,
          status: 'done',
          translations: { ...message.translations, [conversationLanguage]: message.content },
        } : message,
      ));
      if (shouldGenerateTitle) void generateConversationTitle(conversationId, state.apiKey, text);
    } catch (error) {
      const message = friendlyError(error);
      updateActiveMessages((current) => current.map((item) =>
        item.id === assistantId ? {
          ...item,
          content: item.content || message,
          status: 'error',
          translations: { ...item.translations, [conversationLanguage]: item.content || message },
        } : item,
      ));
      if (shouldGenerateTitle) {
        const fallbackTitle = compactTitle(text, copy.titleFallback);
        setState((current) => ({
          ...current,
          conversations: current.conversations.map((item) => item.id === conversationId ? { ...item, title: fallbackTitle } : item),
        }));
      }
    } finally {
      abortRef.current = undefined;
      setBusy(false);
      setStatus('空闲');
      setTurnControls(DEFAULT_TURN_CONTROLS);
      setScopeOpen(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function jumpConversation(edge: 'top' | 'bottom') {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: edge === 'top' ? 0 : node.scrollHeight, behavior: 'smooth' });
  }

  function keepComposerVisible() {
    const reveal = () => {
      const viewport = window.visualViewport;
      const visibleBottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
      const composer = composerRef.current;
      if (composer) {
        const overlap = Math.max(0, composer.getBoundingClientRect().bottom - visibleBottom);
        const currentKeyboardHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--keyboard-height')) || 0;
        document.documentElement.style.setProperty('--keyboard-height', `${Math.ceil(Math.max(currentKeyboardHeight, overlap))}px`);
      }
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    };
    [0, 120, 300, 600].forEach((delay) => window.setTimeout(reveal, delay));
  }

  async function testConnection() {
    if (!state.apiKey.trim()) {
      setConnectionMessage('请先填写 API Key。');
      return;
    }
    setTesting(true);
    setConnectionMessage(`${copy.testing} DeepSeek…`);
    try {
      await testDeepSeekConnection(state.apiKey, AbortSignal.timeout(20_000));
      setConnectionMessage(copy.connectionSuccess);
    } catch (error) {
      setConnectionMessage(friendlyError(error));
    } finally {
      setTesting(false);
    }
  }

  function addMemory() {
    const text = memoryDraft.trim();
    if (!text) return;
    updateState({ memories: [...state.memories.filter((item) => item !== text), text].slice(-16) });
    setMemoryDraft('');
  }

  function removeMemory(text: string) {
    updateState({ memories: state.memories.filter((item) => item !== text) });
  }

  function exportLocalData() {
    const payload = JSON.stringify({ ...state, apiKey: undefined, profile: { ...state.profile, studentPassword: undefined } }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `zaichang-mobile-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setDataMessage('已导出本机资料（已排除 API Key 和校园密码）。');
  }

  function clearLocalData() {
    if (!clearConfirm) {
      setClearConfirm(true);
      return;
    }
    clearMobileState();
    setState(createInitialState());
    setClearConfirm(false);
    setDataMessage('本机对话、记忆、安排和校园缓存已清空。');
    setConnectionMessage('');
  }

  async function createReminderRecord(input: { title: string; dueAt: string; notes: string }): Promise<Record<string, unknown>> {
    const reminder = withNotificationId({
      id: newId('reminder'),
      title: input.title.trim().slice(0, 120),
      notes: input.notes.trim().slice(0, 500),
      dueAt: input.dueAt,
      createdAt: new Date().toISOString(),
      completed: false,
    });
    setState((current) => ({ ...current, reminders: [...current.reminders, reminder].sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 100) }));
    try {
      const notification = await scheduleLocalReminder(reminder);
      return { status: 'ok', reminder: { title: reminder.title, due_at: reminder.dueAt }, notification };
    } catch (error) {
      return { status: 'ok', reminder: { title: reminder.title, due_at: reminder.dueAt }, notification: 'not-scheduled', reason: error instanceof Error ? error.message : '系统通知未安排。' };
    }
  }

  async function createAgendaRecord(input: { title: string; detail: string; startsAt?: string; durationMinutes?: number }): Promise<Record<string, unknown>> {
    const item: MobileAgendaItem = {
      id: newId('action'),
      title: input.title.trim().slice(0, 160),
      detail: input.detail.trim().slice(0, 500),
      ...(input.startsAt ? { startsAt: input.startsAt } : {}),
      ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
      createdAt: new Date().toISOString(),
      status: 'saved',
      source: 'assistant',
    };
    setState((current) => ({ ...current, agenda: [...current.agenda.filter((entry) => entry.id !== item.id), item].slice(-100) }));
    return { status: 'saved', action: { id: item.id, title: item.title, detail: item.detail, starts_at: item.startsAt, duration_minutes: item.durationMinutes }, undo: '可在本地安排页面撤销' };
  }

  async function updateAgendaRecord(id: string, status: 'done' | 'cancelled'): Promise<Record<string, unknown>> {
    const existing = state.agenda.find((item) => item.id === id);
    if (!existing) return { status: 'known_absent', reason: '没有找到这项本地安排。' };
    setState((current) => ({ ...current, agenda: current.agenda.map((item) => item.id === id ? { ...item, status } : item) }));
    return { status: 'confirmed_success', action_id: id, action_status: status };
  }

  async function addReminder() {
    const title = reminderTitleDraft.trim();
    const dueAt = new Date(reminderTimeDraft);
    if (!title || Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
      setReminderMessage(state.profile.language === 'en' ? 'Enter a future time and reminder.' : state.profile.language === 'zh-TW' ? '請輸入未來的時間和提醒內容。' : '请输入未来的时间和提醒内容。');
      return;
    }
    const result = await createReminderRecord({ title, dueAt: dueAt.toISOString(), notes: reminderNotesDraft });
    setReminderTitleDraft('');
    setReminderNotesDraft('');
    setReminderTimeDraft(localDateTimeValue());
    setReminderMessage(result.notification === 'permission-denied' ? copy.notificationDenied : result.notification === 'web' ? copy.webReminderNote : copy.reminderSaved);
  }

  async function completeReminder(reminder: MobileReminder) {
    await cancelLocalReminder(reminder).catch(() => {});
    updateState({ reminders: state.reminders.map((item) => item.id === reminder.id ? { ...item, completed: true } : item) });
  }

  async function deleteReminder(reminder: MobileReminder) {
    await cancelLocalReminder(reminder).catch(() => {});
    updateState({ reminders: state.reminders.filter((item) => item.id !== reminder.id) });
  }

  function completeAgenda(item: MobileAgendaItem) {
    if (item.status !== 'saved') return;
    updateState({ agenda: state.agenda.map((entry) => entry.id === item.id ? { ...entry, status: 'done' } : entry) });
  }

  function deleteAgenda(item: MobileAgendaItem) {
    updateState({ agenda: state.agenda.map((entry) => entry.id === item.id ? { ...entry, status: 'cancelled' } : entry) });
  }

  function openHistory() {
    setHistoryOpen(true);
    setProfileOpen(false);
    setCampusOpen(false);
    setRemindersOpen(false);
    setAgendaOpen(false);
  }

  function closeOverlays() {
    setHistoryOpen(false);
    setProfileOpen(false);
    setCampusOpen(false);
    setRemindersOpen(false);
    setAgendaOpen(false);
    setHistoryMenuId(null);
    setRenamingId(null);
  }

  function createNewConversation() {
    if (busy) return;
    if (!messages.length && activeConversation?.title === copy.newConversation) {
      closeOverlays();
      return;
    }
    const conversation = createConversation(copy.newConversation);
    setState((current) => ({
      ...current,
      conversations: [conversation, ...current.conversations],
      activeConversationId: conversation.id,
    }));
    closeOverlays();
  }

  function selectConversation(id: string) {
    if (busy) return;
    updateState({ activeConversationId: id });
    closeOverlays();
  }

  function startRename(conversation: MobileConversation) {
    setHistoryMenuId(null);
    setRenamingId(conversation.id);
    setRenameDraft(conversation.title);
  }

  function saveRename(id: string) {
    const title = compactTitle(renameDraft, copy.titleFallback);
    setState((current) => ({
      ...current,
      conversations: current.conversations.map((item) => item.id === id ? { ...item, title } : item),
    }));
    setRenamingId(null);
    setRenameDraft('');
  }

  function deleteConversation(id: string) {
    if (busy) return;
    setState((current) => {
      const remaining = current.conversations.filter((item) => item.id !== id);
      if (remaining.length) {
        return {
          ...current,
          conversations: remaining,
          activeConversationId: current.activeConversationId === id ? remaining[0].id : current.activeConversationId,
        };
      }
      const fresh = createConversation(copy.newConversation);
      return { ...current, conversations: [fresh], activeConversationId: fresh.id };
    });
    setHistoryMenuId(null);
  }

  function openProfile() {
    setHistoryOpen(false);
    setProfileOpen(true);
    setCampusOpen(false);
    setRemindersOpen(false);
    setAgendaOpen(false);
  }

  function openReminders() {
    setCampusOpen(false);
    setRemindersOpen(true);
    setAgendaOpen(false);
    setReminderMessage('');
  }

  function openAgenda() {
    setHistoryOpen(false);
    setProfileOpen(true);
    setCampusOpen(false);
    setRemindersOpen(false);
    setAgendaOpen(true);
  }

  function openMap() {
    closeOverlays();
    setMapOpen(true);
    setWeatherOpen(false);
  }

  function openWeather() {
    closeOverlays();
    setWeatherOpen(true);
    setMapOpen(false);
  }

  const themeClass = state.profile.theme === 'dark' ? 'theme-dark' : 'theme-light';
  const campus = state.campus;
  const upcomingExams = campus?.exams.filter((exam) => exam.status === 'upcoming') || [];
  const finishedExams = campus?.exams.filter((exam) => exam.status === 'finished') || [];
  const unknownExams = campus?.exams.filter((exam) => exam.status === 'unknown') || [];
  const scopeLabel = turnControls.retention === 'session_only'
    ? '本轮不保存'
    : turnControls.memoryMode === 'current_sources_only'
      ? '只看本条与附件'
      : turnControls.memoryMode === 'none'
        ? '不参考历史与记忆'
        : '按需参考本机资料';

  return (
    <main className={`app-shell ${themeClass}`}>
      <header className="topbar">
        <button className="header-icon-button" aria-label={copy.history} onClick={openHistory}>
          <HistoryIcon />
        </button>
        <div className="topbar-title">{copy.appName}</div>
        <div className="topbar-actions">
          <button className="header-icon-button" aria-label={state.profile.language === 'en' ? 'Map' : '地图'} onClick={openMap}><MapIcon /></button>
          <button className="header-icon-button" aria-label={state.profile.language === 'en' ? 'Weather' : '天气'} onClick={openWeather}><WeatherIcon /></button>
          <button className="header-icon-button" aria-label={copy.agendaTitle} onClick={openAgenda}><CalendarIcon /></button>
          <button className="header-icon-button" aria-label={copy.newConversation} onClick={createNewConversation}><PlusIcon /></button>
        </div>
      </header>

      <section className="conversation" ref={scrollRef} aria-live="polite">
        {!messages.length && (
          <div className="welcome-card">
            <div className="welcome-orb">在</div>
            <h1>{copy.welcomeTitle}</h1>
            <p>{copy.welcomeBody}</p>
            <div className="suggestion-list">
              {copy.suggestions.map((suggestion) => (
                <button key={suggestion} onClick={() => setDraft(suggestion)}>
                  <span>{suggestion}</span>
                  <ArrowIcon />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <article className={`message ${message.role} ${message.status}`} key={message.id}>
            <div className="message-author">
              {message.role === 'assistant' && <span className="message-avatar">在</span>}
              <span>{message.role === 'user' ? copy.user : copy.assistant}</span>
              <time>{formatTime(message.createdAt, state.profile.language)}</time>
            </div>
            <div className="message-bubble">
              {message.attachment?.kind === 'image' && <img className="message-image" src={message.attachment.dataUrl} alt={message.attachment.name} />}
              {message.attachment?.kind === 'text' && <div className="message-file"><AttachmentIcon /><span>{message.attachment.name}</span></div>}
              {message.content ? <MessageContent content={message.content} /> : (message.status === 'running' ? <span className="typing">{copy.typing}</span> : '')}
            </div>
          </article>
        ))}
      </section>

      {messages.length > 0 && (scrollState.canUp || scrollState.canDown) && (
        <div className="scroll-jump" aria-label="对话位置">
          <button disabled={!scrollState.canUp} aria-label="回到顶部" onClick={() => jumpConversation('top')}><ChevronUpIcon /></button>
          <button disabled={!scrollState.canDown} aria-label="回到底部" onClick={() => jumpConversation('bottom')}><ChevronDownIcon /></button>
        </div>
      )}

      <footer className="composer-area" ref={composerRef}>
        {attachmentDraft && (
          <div className="attachment-draft">
            <span className="attachment-draft-icon">{attachmentDraft.kind === 'image' ? <img src={attachmentDraft.dataUrl} alt="" /> : <AttachmentIcon />}</span>
            <span className="attachment-draft-name">{attachmentDraft.name}</span>
            <button type="button" aria-label={copy.removeAttachment} onClick={() => setAttachmentDraft(null)}><CloseIcon /></button>
          </div>
        )}
        {attachmentMessage && <p className="attachment-message">{attachmentMessage}</p>}
        <div className="composer">
          <label className="attachment-button" htmlFor="message-attachment" aria-label={copy.attachFile}>
            <AttachmentIcon />
          </label>
          <input
            id="message-attachment"
            className="avatar-file-input"
            type="file"
            accept="image/*,.txt,.md,.json,.csv,.log"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleAttachmentFile(file); event.currentTarget.value = ''; }}
          />
          <button className={`scope-button ${scopeOpen ? 'selected' : ''}`} type="button" onClick={() => setScopeOpen((open) => !open)} aria-label="设置本轮资料范围">
            {scopeLabel}
          </button>
          <textarea
            value={draft}
            disabled={busy}
            placeholder={copy.draftPlaceholder}
            aria-label={copy.user}
            rows={1}
            onFocus={keepComposerVisible}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button className="stop-button" onClick={stop}>{copy.stop}</button>
          ) : (
            <button className="send-button" disabled={!draft.trim() && !attachmentDraft} onClick={() => void send()} aria-label="发送">
              <ArrowIcon />
            </button>
          )}
        </div>
        {scopeOpen && (
          <section className="scope-popover" aria-label="本轮资料范围">
            <label><span>可以参考什么</span><select value={turnControls.memoryMode} onChange={(event) => setTurnControls((current) => ({ ...current, memoryMode: event.target.value as MobileTurnControls['memoryMode'] }))}>
              <option value="relevant">按需参考相关本机资料</option>
              <option value="current_sources_only">只看本条消息与附件</option>
              <option value="none">不参考历史与长期记忆</option>
            </select></label>
            <label><span>这条消息怎样保留</span><select value={turnControls.retention} onChange={(event) => setTurnControls((current) => ({ ...current, retention: event.target.value as MobileTurnControls['retention'] }))}>
              <option value="purpose_scoped">保留对话，按需整理记忆</option>
              <option value="history_no_inference">保留对话，不形成长期记忆</option>
              <option value="session_only">本轮不保存</option>
            </select></label>
            <label><span>回复受众</span><select value={turnControls.audience} onChange={(event) => setTurnControls((current) => ({ ...current, audience: event.target.value as MobileTurnControls['audience'] }))}>
              <option value="self">只给我看</option>
              <option value="group">准备给群里看的草稿</option>
              <option value="public">准备公开的草稿</option>
            </select></label>
            {turnControls.audience !== 'self' && <p>只生成草稿，不会自动发送。</p>}
          </section>
        )}
      </footer>

      {historyOpen && (
        <>
          <button className="drawer-backdrop" aria-label={copy.close} onClick={closeOverlays} />
          <aside className="history-drawer" aria-label={copy.historyTitle}>
            <div className="drawer-topbar">
              <div>
                <h2>{copy.historyTitle}</h2>
              </div>
              <button className="icon-button" aria-label={copy.close} onClick={closeOverlays}><CloseIcon /></button>
            </div>
            <input className="history-search" value={historyQuery} placeholder={copy.historySearchPlaceholder} onChange={(event) => setHistoryQuery(event.target.value)} />
            <div className="history-list">
              {visibleConversations.length ? visibleConversations.map((conversation) => (
                <div className={`history-item ${conversation.id === activeConversation?.id ? 'active' : ''}`} key={conversation.id}>
                  {renamingId === conversation.id ? (
                    <div className="rename-row">
                      <input value={renameDraft} autoFocus placeholder={copy.renamePlaceholder} onChange={(event) => setRenameDraft(event.target.value)} />
                      <button onClick={() => saveRename(conversation.id)}>{copy.done}</button>
                      <button onClick={() => setRenamingId(null)}>{copy.cancel}</button>
                    </div>
                  ) : (
                    <button className="history-item-main" onClick={() => selectConversation(conversation.id)}>
                      <span className="history-item-title">{conversation.title}</span>
                      <span className="history-item-meta">{conversation.messages.length ? `${conversation.messages.length} · ` : ''}{formatHistoryDate(conversation.updatedAt, state.profile.language)}</span>
                    </button>
                  )}
                  {renamingId !== conversation.id && (
                    <button className="more-button" aria-label="更多操作" onClick={(event) => { event.stopPropagation(); setHistoryMenuId(historyMenuId === conversation.id ? null : conversation.id); }}>
                      <MoreIcon />
                    </button>
                  )}
                  {historyMenuId === conversation.id && (
                    <div className="history-menu">
                      <button onClick={() => startRename(conversation)}>{copy.rename}</button>
                      <button className="danger-button" onClick={() => deleteConversation(conversation.id)}>{copy.delete}</button>
                    </div>
                  )}
                </div>
              )) : <p className="empty-history">{historyQuery.trim() ? copy.historyEmpty : copy.historyEmpty}</p>}
            </div>
            <button className="profile-entry" onClick={openProfile}>
              <Avatar className="profile-avatar" value={state.profile.avatar} />
              <span className="profile-entry-copy"><strong>{copy.profileEyebrow}</strong></span>
              <SettingsIcon />
            </button>
          </aside>
        </>
      )}

      {profileOpen && !campusOpen && !remindersOpen && !agendaOpen && (
        <section className="full-screen-panel" aria-label={copy.profileTitle}>
          <header className="secondary-topbar">
            <button className="back-button" onClick={() => { setProfileOpen(false); setHistoryOpen(true); }}><BackIcon /><span>{copy.back}</span></button>
            <h2>{copy.profileEyebrow}</h2>
            <span className="topbar-spacer" />
          </header>
          <div className="settings-scroll">
            <section className="profile-section avatar-section">
              <div className="avatar-setting-row">
                <Avatar className="profile-avatar profile-avatar-large" value={state.profile.avatar} />
                <div className="setting-label"><strong>{copy.avatar}</strong></div>
              </div>
              <label className="avatar-upload-button" htmlFor="avatar-file">
                <span>{copy.avatarHint}</span><ArrowIcon />
              </label>
              <input id="avatar-file" className="avatar-file-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleAvatarFile(file); event.currentTarget.value = ''; }} />
              {avatarMessage && <p className="connection-message">{avatarMessage}</p>}
            </section>
            <section className="profile-section setting-row">
              <div className="setting-label"><strong>{copy.language}</strong><span>中文、繁體中文、English</span></div>
              <select
                value={state.profile.language}
                disabled={busy || translating}
                onChange={(event) => void changeLanguage(event.target.value as MobileLanguage)}
              >
                <option value="zh-CN">中文（简体）</option>
                <option value="zh-TW">中文（繁體）</option>
                <option value="en">English</option>
              </select>
              {translationMessage && <p className="connection-message">{translationMessage}</p>}
            </section>
            <section className="profile-section setting-row">
              <div className="setting-label"><strong>{copy.appearance}</strong><span>{state.profile.theme === 'light' ? copy.light : copy.dark}</span></div>
              <div className="segmented-control">
                <button className={state.profile.theme === 'light' ? 'selected' : ''} onClick={() => updateProfile({ theme: 'light' as MobileTheme })}>{copy.light}</button>
                <button className={state.profile.theme === 'dark' ? 'selected' : ''} onClick={() => updateProfile({ theme: 'dark' as MobileTheme })}>{copy.dark}</button>
              </div>
            </section>
            <section className="profile-section memory-section">
              <div className="setting-label"><strong>{copy.memoryTitle}</strong><span>{copy.memoryEyebrow}</span></div>
              {state.memories.length > 0 && (
                <div className="memory-list">
                  {state.memories.map((memory) => (
                    <div className="memory-item" key={memory}>
                      <span>{memory}</span>
                      <button type="button" aria-label={copy.memoryRemove} onClick={() => removeMemory(memory)}><CloseIcon /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="memory-row">
                <input value={memoryDraft} placeholder={copy.memoryPlaceholder} onChange={(event) => setMemoryDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addMemory(); } }} />
                <button className="primary-button" disabled={!memoryDraft.trim()} onClick={addMemory}>{copy.save}</button>
              </div>
            </section>
            <button className="profile-link" onClick={openReminders}>
              <span><strong>{copy.reminders}</strong><small>{copy.remindersHint}</small></span><BellIcon />
            </button>
            <button className="profile-link" onClick={openAgenda}>
              <span><strong>{copy.agenda}</strong><small>{copy.agendaHint}</small></span><CalendarIcon />
            </button>
            <button className="profile-link" onClick={() => { setCampusOpen(true); setCampusSaved(false); }}>
              <span><strong>{copy.campus}</strong><small>{copy.campusHint}</small></span><ArrowIcon />
            </button>
            {import.meta.env.DEV && !isMobileVmSession() && (
              <button className="profile-link" onClick={launchMobileVm}>
                <span><strong>手机端虚拟机</strong><small>在浏览器手机壳中测试尺寸、旋转、网络和定位</small></span><ArrowIcon />
              </button>
            )}
            <section className="profile-section api-key-section">
              <div className="setting-label"><strong>{copy.apiKey}</strong><span>{copy.secureNote}</span></div>
              <div className="key-row">
                <input
                  id="profile-api-key"
                  type="password"
                  value={state.apiKey}
                  placeholder="sk-…"
                  autoComplete="off"
                  onChange={(event) => updateState({ apiKey: event.target.value })}
                />
                <button className="primary-button" disabled={testing} onClick={() => void testConnection()}>
                  {testing ? copy.testing : copy.testConnection}
                </button>
              </div>
              {connectionMessage && <p className="connection-message">{connectionMessage}</p>}
            </section>
            <section className="profile-section data-section">
              <div className="setting-label"><strong>本机资料</strong><span>导出的 JSON 不包含 API Key 和校园密码；清空后无法恢复。</span></div>
              <div className="campus-account-actions">
                <button className="secondary-button" onClick={exportLocalData}>导出资料</button>
                <button className="danger-button" onClick={clearLocalData}>{clearConfirm ? '确认清空' : '清空本机资料'}</button>
              </div>
              {clearConfirm && <p className="connection-message">再次点击将删除本机对话、记忆、安排、提醒和校园缓存。</p>}
              {dataMessage && <p className="connection-message">{dataMessage}</p>}
            </section>
          </div>
        </section>
      )}

      {profileOpen && agendaOpen && !campusOpen && !remindersOpen && (
        <section className="full-screen-panel" aria-label={copy.agendaTitle}>
          <header className="secondary-topbar">
            <button className="back-button" onClick={() => setAgendaOpen(false)}><BackIcon /><span>{copy.back}</span></button>
            <h2>{copy.agendaTitle}</h2>
            <span className="topbar-spacer" />
          </header>
          <div className="settings-scroll reminders-screen">
            <section className="profile-section reminder-list-section">
              <div className="setting-label"><strong>{copy.agendaTitle}</strong><span>{state.agenda.filter((item) => item.status !== 'cancelled').length || copy.agendaEmpty}</span></div>
              {state.agenda.filter((item) => item.status !== 'cancelled').length > 0 ? state.agenda.filter((item) => item.status !== 'cancelled').map((item) => (
                <div className={`reminder-item ${item.status === 'done' ? 'completed' : ''}`} key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.startsAt ? `${copy.agendaTime} · ${formatReminderDate(item.startsAt, state.profile.language)}` : copy.agendaSaved}{item.detail ? ` · ${item.detail}` : ''}</small>
                  </div>
                  <div className="reminder-actions">
                    {item.status === 'saved' && <button type="button" onClick={() => completeAgenda(item)}>{copy.complete}</button>}
                    <button type="button" aria-label={copy.delete} onClick={() => deleteAgenda(item)}><CloseIcon /></button>
                  </div>
                </div>
              )) : <p className="empty-history">{copy.agendaEmpty}</p>}
            </section>
            <p className="campus-privacy-note">{copy.agendaHint}</p>
          </div>
        </section>
      )}

      {profileOpen && remindersOpen && !campusOpen && !agendaOpen && (
        <section className="full-screen-panel" aria-label={copy.remindersTitle}>
          <header className="secondary-topbar">
            <button className="back-button" onClick={() => setRemindersOpen(false)}><BackIcon /><span>{copy.back}</span></button>
            <h2>{copy.remindersTitle}</h2>
            <span className="topbar-spacer" />
          </header>
          <div className="settings-scroll reminders-screen">
            <section className="profile-section reminder-form">
              <div className="setting-label"><strong>{copy.addReminder}</strong><span>{copy.remindersHint}</span></div>
              <label className="field-label" htmlFor="reminder-title">{copy.reminderTitle}</label>
              <input id="reminder-title" value={reminderTitleDraft} placeholder={copy.reminderTitle} onChange={(event) => setReminderTitleDraft(event.target.value)} />
              <label className="field-label" htmlFor="reminder-time">{copy.reminderTime}</label>
              <input id="reminder-time" type="datetime-local" value={reminderTimeDraft} onChange={(event) => setReminderTimeDraft(event.target.value)} />
              <label className="field-label" htmlFor="reminder-notes">{copy.reminderNotes}</label>
              <input id="reminder-notes" value={reminderNotesDraft} placeholder={copy.reminderNotes} onChange={(event) => setReminderNotesDraft(event.target.value)} />
              <button className="save-wide-button" onClick={() => void addReminder()}>{copy.addReminder}</button>
              {reminderMessage && <p className="connection-message">{reminderMessage}</p>}
            </section>
            <section className="profile-section reminder-list-section">
              <div className="setting-label"><strong>{copy.remindersTitle}</strong><span>{state.reminders.length ? `${state.reminders.length}` : copy.reminderEmpty}</span></div>
              {state.reminders.length > 0 ? state.reminders.map((reminder) => (
                <div className={`reminder-item ${reminder.completed ? 'completed' : ''}`} key={reminder.id}>
                  <div><strong>{reminder.title}</strong><small>{formatReminderDate(reminder.dueAt, state.profile.language)}{reminder.notes ? ` · ${reminder.notes}` : ''}</small></div>
                  <div className="reminder-actions">
                    {!reminder.completed && <button type="button" onClick={() => void completeReminder(reminder)}>{copy.complete}</button>}
                    <button type="button" aria-label={copy.delete} onClick={() => void deleteReminder(reminder)}><CloseIcon /></button>
                  </div>
                </div>
              )) : <p className="empty-history">{copy.reminderEmpty}</p>}
            </section>
          </div>
        </section>
      )}

      {profileOpen && campusOpen && (
        <section className="full-screen-panel" aria-label={copy.campusTitle}>
          <header className="secondary-topbar">
            <button className="back-button" onClick={() => setCampusOpen(false)}><BackIcon /><span>{copy.back}</span></button>
            <h2>{copy.campusTitle}</h2>
            <span className="topbar-spacer" />
          </header>
          <div className="settings-scroll campus-screen">
            <section className="profile-section campus-account-card">
              <div className="setting-label"><strong>{copy.campus}</strong><span>{copy.campusHint}</span></div>
              <label className="field-label" htmlFor="student-id">{copy.studentId}</label>
              <input id="student-id" value={state.profile.studentId} placeholder={copy.studentId} onChange={(event) => { updateProfile({ studentId: event.target.value }); updateState({ campus: null }); setCampusSaved(false); }} />
              <label className="field-label" htmlFor="student-password">{copy.studentPassword}</label>
              <input id="student-password" type="password" value={state.profile.studentPassword} placeholder={copy.passwordPlaceholder} onChange={(event) => { updateProfile({ studentPassword: event.target.value }); updateState({ campus: null }); setCampusSaved(false); }} />
              <div className="campus-read-options">
                <label className="field-label" htmlFor="campus-academic-year">{copy.campusAcademicYear}</label>
                <select id="campus-academic-year" value={campusAcademicYear} onChange={(event) => { setCampusAcademicYear(event.target.value); updateState({ campus: null }); setCampusSaved(false); }}>
                  {[0, 1, 2, 3].map((offset) => {
                    const year = String(Number(initialAcademicTerm.year) - 1 + offset);
                    return <option key={year} value={year}>{year}–{Number(year) + 1}</option>;
                  })}
                </select>
                <label className="field-label" htmlFor="campus-term">{copy.campusTerm}</label>
                <select id="campus-term" value={campusTerm} onChange={(event) => { setCampusTerm(event.target.value); updateState({ campus: null }); setCampusSaved(false); }}>
                  <option value="1">{copy.campusAutumnTerm}</option>
                  <option value="2">{copy.campusSpringTerm}</option>
                </select>
              </div>
              <div className="campus-account-actions">
                <button className="secondary-button" onClick={() => setCampusSaved(true)}>{campusSaved ? copy.saved : copy.save}</button>
                <button className="primary-button" disabled={campusLoading} onClick={() => void refreshCampusInfo()}>{campusLoading ? copy.campusLoading : copy.campusRefresh}</button>
              </div>
              <button className="secondary-button campus-webvpn-button" onClick={() => void openCampusWebVpn()}>{copy.campusWebVpn}</button>
              <p className="campus-privacy-note">{copy.campusReadOnly}</p>
              {campusMessage && <p className="connection-message">{campusMessage}</p>}
            </section>

            {campus && (
              <>
                <section className="campus-status-row">
                  <div><strong>{campus.warnings.length ? copy.campusPartial : copy.campusUpdated}</strong><small>{formatCampusUpdated(campus.fetchedAt, state.profile.language)} · {campus.academicYear}–{Number(campus.academicYear) + 1} · {campusTermLabel(campus.term)} · {campus.yearLevel || '年级未识别'}</small></div>
                  <button className="icon-refresh-button" disabled={campusLoading} onClick={() => void refreshCampusInfo()} aria-label={copy.campusRefresh}>↻</button>
                </section>
                {campus.warnings.length > 0 && (
                  <section className="campus-warning" role="status">
                    <strong>{copy.campusPartial}</strong>
                    {campus.warnings.map((warning) => <small key={warning}>{warning}</small>)}
                  </section>
                )}
              </>
            )}
            <div className="campus-tabs" role="tablist" aria-label={copy.campusTitle}>
              {([
                ['overview', copy.campusOverview],
                ['schedule', copy.campusSchedule],
                ['courses', '课程教学班'],
                ['learning', '学在浙大'],
                ['activities', '课程活动'],
                ['exams', copy.campusExams],
                ['grades', copy.campusGrades],
                ['gpa', '绩点分析'],
                ['todos', copy.campusTodos],
                ['practice', copy.campusPractice],
                ['holidays', '校历'],
                ['notices', copy.campusNotices],
                ['public', copy.campusPublic],
              ] as const).map(([tab, label]) => (
                <button key={tab} className={campusTab === tab ? 'selected' : ''} role="tab" aria-selected={campusTab === tab} onClick={() => selectCampusTab(tab)}>{label}</button>
              ))}
            </div>
            {campus && (
              <>
                {campusTab === 'overview' && (
                  <section className="campus-overview">
                    <div className="campus-overview-metrics">
                      <div><strong>{campus.gpa === null ? '—' : campus.gpa.toFixed(2)}</strong><span>{copy.campusGpa}</span></div>
                      <div><strong>{campus.completedCredit.toFixed(1)}</strong><span>{copy.campusCompletedCredit}</span></div>
                      <div><strong>{campus.earnedCredit.toFixed(1)}</strong><span>{copy.campusEarnedCredit}</span></div>
                      <div><strong>{campus.courses.length}</strong><span>{copy.campusCoursesCount}</span></div>
                      <div><strong>{campus.todos.length}</strong><span>{copy.campusTodosCount}</span></div>
                      <div><strong>{campus.practiceProjects?.length || 0}</strong><span>{copy.campusPracticeProjects}</span></div>
                    </div>
                    <div className="campus-overview-links">
                      <button onClick={() => setCampusTab('schedule')}><span>{copy.campusSchedule}</span><strong>{campus.courses.length}</strong><ArrowIcon /></button>
                      <button onClick={() => setCampusTab('exams')}><span>{copy.campusExams}</span><strong>{campus.exams.length}</strong><ArrowIcon /></button>
                      <button onClick={() => setCampusTab('grades')}><span>{copy.campusGrades}</span><strong>{campus.grades.length}</strong><ArrowIcon /></button>
                      <button onClick={() => setCampusTab('practice')}><span>{copy.campusPractice}</span><strong>{campus.practiceProjects?.length || 0}</strong><ArrowIcon /></button>
                    </div>
                  </section>
                )}

                {campusTab === 'schedule' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>{copy.campusSchedule}</strong><span>{campus.courses.length ? `${campus.courses.length} · ${campus.academicYear}–${Number(campus.academicYear) + 1} · ${campusTermLabel(campus.term)} · ${campus.yearLevel || '年级未识别'} · ${copy.campusCompletedCredit} ${campus.completedCredit.toFixed(1)}` : copy.campusEmpty}</span></div>
                    {campus.courses.length ? campus.courses.map((course) => (
                      <div className="campus-record" key={course.id}>
                        <strong>{course.name}</strong><span>{course.time} · {course.location || copy.campusNoLocation}</span><small>{course.teacher} · {course.weeks}</small><small>{copy.campusCourseCredit}：{course.credit || '—'}{course.completed ? ` · ${copy.campusCourseCompleted}` : ''}{course.score && course.score !== '—' ? ` · ${course.score}` : ''}</small>
                      </div>
                    )) : <p className="empty-history">{copy.campusEmpty}</p>}
                  </section>
                )}

                {campusTab === 'courses' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>课程教学班</strong><span>{campus.courseOfferings.length ? `${campus.courseOfferings.length} 门` : copy.campusEmpty}</span></div>
                    {campus.courseOfferings.length ? campus.courseOfferings.map((course) => (
                      <div className="campus-record" key={course.id}>
                        <strong>{course.name}</strong>
                        <span>{course.credit && course.credit !== '—' ? `${course.credit} 学分` : '学分未提供'} · {course.semesterId}</span>
                        <small>{course.teachers || '教师未提供'}{course.online === true ? ' · 线上' : ''}</small>
                      </div>
                    )) : <p className="empty-history">{copy.campusEmpty}</p>}
                  </section>
                )}

                {campusTab === 'learning' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>学在浙大课程</strong><span>{campus.learningCourses.length ? `${campus.learningCourses.length} 门` : copy.campusEmpty}</span></div>
                    {campus.learningCourses.length ? campus.learningCourses.map((course) => (
                      <div className="campus-record" key={course.id}>
                        <strong>{course.name}</strong>
                        <span>{[course.code, course.term, course.credit && `${course.credit} 学分`].filter(Boolean).join(' · ') || '课程信息未提供'}</span>
                        <small>{course.teachers || '教师未提供'} · ID {course.id}</small>
                      </div>
                    )) : <p className="empty-history">{copy.campusEmpty}</p>}
                    <p className="connection-message">需要读取某门课程的活动时，可以在对话中询问课程作业或截止时间。</p>
                  </section>
                )}

                {campusTab === 'activities' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>课程活动</strong><span>{campus.activities.length ? `${campus.activities.length} 项` : '默认同步只读取课程列表'}</span></div>
                    {campus.activities.length ? campus.activities.map((activity) => (
                      <div className="campus-record" key={activity.id}>
                        <strong>{activity.title}</strong><span>{[activity.type, activity.deadline || activity.startTime].filter(Boolean).join(' · ')}</span><small>{activity.status || '状态未提供'}</small>
                      </div>
                    )) : <p className="empty-history">暂无已缓存活动；在对话中询问指定课程的作业或活动后会按课程读取。</p>}
                  </section>
                )}

                {campusTab === 'exams' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>{copy.campusExams}</strong><span>{campus.exams.length ? `${campus.exams.length}` : copy.campusEmpty}</span></div>
                    <div className="campus-exam-group"><div className="campus-group-label"><strong>{copy.campusUpcoming}</strong><span>{upcomingExams.length}</span></div>{upcomingExams.length ? upcomingExams.map((exam) => (
                      <div className="campus-record" key={exam.id}><strong>{exam.name}</strong><span>{exam.time}</span><small>{exam.location || copy.campusNoLocation}{exam.seat ? ` · ${exam.seat}` : ''}</small></div>
                    )) : <p className="empty-history">{copy.campusEmpty}</p>}</div>
                    <div className="campus-exam-group"><div className="campus-group-label"><strong>{copy.campusFinished}</strong><span>{finishedExams.length}</span></div>{finishedExams.length ? finishedExams.map((exam) => (
                      <div className="campus-record" key={exam.id}><strong>{exam.name}</strong><span>{exam.time}</span><small>{exam.location || copy.campusNoLocation}{exam.seat ? ` · ${exam.seat}` : ''}</small></div>
                    )) : <p className="empty-history">{copy.campusEmpty}</p>}</div>
                    {unknownExams.length > 0 && <div className="campus-exam-group"><div className="campus-group-label"><strong>{copy.campusUnknown}</strong><span>{unknownExams.length}</span></div>{unknownExams.map((exam) => (
                      <div className="campus-record" key={exam.id}><strong>{exam.name}</strong><span>{exam.time}</span><small>{exam.location || copy.campusNoLocation}{exam.seat ? ` · ${exam.seat}` : ''}</small></div>
                    ))}</div>}
                  </section>
                )}

                {campusTab === 'grades' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>{copy.campusGrades}</strong><span>{campus.grades.length ? `${campus.grades.length}` : copy.campusEmpty}</span></div>
                    <div className="campus-grade-summary"><div><span>{copy.campusGpa}</span><strong>{campus.gpa === null ? '—' : campus.gpa.toFixed(2)}</strong></div><div><span>{copy.campusCompletedCredit}</span><strong>{campus.completedCredit.toFixed(1)}</strong></div><div><span>{copy.campusEarnedCredit}</span><strong>{campus.earnedCredit.toFixed(1)}</strong></div></div>
                    {campus.grades.length ? campus.grades.map((grade) => (
                      <div className="campus-record campus-grade-record" key={grade.id}>
                        <strong>{grade.name}</strong><span>{grade.score}</span><small>{grade.credit} · {grade.point}</small>
                      </div>
                    )) : <p className="empty-history">{copy.campusEmpty}</p>}
                  </section>
                )}

                {campusTab === 'gpa' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>绩点分析</strong><span>{campus.gpaCumulative?.complete ? '学校完整口径' : '按已返回成绩近似计算'}</span></div>
                    {campus.gpaCumulative && <div className="campus-grade-summary"><div><span>累计绩点</span><strong>{campus.gpaCumulative.gpa === null ? '—' : campus.gpaCumulative.gpa.toFixed(2)}</strong></div><div><span>绩点学分</span><strong>{campus.gpaCumulative.creditDenominator.toFixed(1)}</strong></div><div><span>排除记录</span><strong>{campus.gpaCumulative.excludedAttempts}</strong></div></div>}
                    {campus.gradeAlerts.length > 0 && <><div className="campus-group-label"><strong>成绩风险提示</strong><span>{campus.gradeAlerts.length}</span></div>{campus.gradeAlerts.map((alert) => <div className="campus-record" key={alert.id}><strong>{alert.name}</strong><span>{alert.level === 'failed' ? '不及格/未通过' : '需要关注'} · {alert.score}</span><small>{alert.credit} 学分 · {alert.note}</small></div>)}</>}
                    {campus.gpaSemesters.length > 0 && <><div className="campus-group-label"><strong>分学期绩点</strong><span>{campus.gpaSemesters.length}</span></div>{campus.gpaSemesters.map((item) => <div className="campus-record" key={item.semesterId || item.throughSemester}><strong>{item.semesterId || item.throughSemester}</strong><span>{item.gpa === null ? '—' : item.gpa.toFixed(2)} · {item.creditDenominator.toFixed(1)} 学分</span><small>{item.note}</small></div>)}</>}
                    {!campus.gpaCumulative && !campus.gradeAlerts.length && !campus.gpaSemesters.length && <p className="empty-history">{copy.campusEmpty}</p>}
                  </section>
                )}

                {campusTab === 'todos' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>{copy.campusTodos}</strong><span>{campus.todos.length ? `${campus.todos.length}` : copy.campusEmpty}</span></div>
                    {campus.todos.length ? campus.todos.map((todo) => (
                      <div className="campus-record" key={todo.id}>
                        <strong>{todo.name}</strong><span>{todo.course}</span><small>{todo.deadline || copy.campusNoDeadline}</small>
                      </div>
                    )) : <p className="empty-history">{copy.campusEmpty}</p>}
                  </section>
                )}

                {campusTab === 'practice' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>{copy.campusPractice}</strong><span>{campus.practiceProjects?.length ? `${campus.practiceProjects.length} · ${copy.campusPracticeProjects}` : copy.campusPracticeEmpty}</span></div>
                    {campus.practiceSummary && (
                      <div className="campus-grade-summary">
                        <div><span>{copy.campusPracticePoints} · 二课</span><strong>{campus.practiceSummary.secondClassPoints ?? '—'}</strong></div>
                        <div><span>{copy.campusPracticePoints} · 三课</span><strong>{campus.practiceSummary.thirdClassPoints ?? '—'}</strong></div>
                        <div><span>{copy.campusPracticePoints} · 四课</span><strong>{campus.practiceSummary.fourthClassPoints ?? '—'}</strong></div>
                      </div>
                    )}
                    {campus.practiceProjects?.length ? campus.practiceProjects.map((project) => (
                      <div className="campus-record" key={project.id}>
                        <strong>{project.name}</strong>
                        <span>{[project.category, project.projectType, project.qualityType].filter(Boolean).join(' · ')}</span>
                        <small>{project.score === null ? '—' : `${project.score} · `}{project.approved ? copy.campusPracticePassed : copy.campusPracticePending}{project.activityTime ? ` · ${project.activityTime}` : ''}</small>
                      </div>
                    )) : <p className="empty-history">{copy.campusPracticeEmpty}</p>}
                  </section>
                )}

                {campusTab === 'holidays' && (
                  <section className="profile-section campus-data-card">
                    <div className="setting-label"><strong>校历与假期</strong><span>{campus.holidays.length ? `${campus.holidays.length} 项` : copy.campusEmpty}</span></div>
                    {campus.holidays.length ? campus.holidays.map((holiday) => <div className="campus-record" key={holiday.id}><strong>{holiday.title}</strong><span>{holiday.startDate} — {holiday.endDate}</span><small>{holiday.note}</small></div>) : <p className="empty-history">{copy.campusEmpty}</p>}
                    <small className="connection-message">{campus.sourceStatus.note}</small>
                  </section>
                )}
              </>
            )}
            {campusTab === 'public' && (
              <section className="profile-section campus-data-card campus-notices-card">
                <div className="setting-label"><strong>{copy.campusPublic}</strong><span>{copy.campusPublicHint}</span></div>
                <div className="notice-search-row">
                  <input
                    value={publicQuery}
                    placeholder={copy.campusPublicSearchPlaceholder}
                    onChange={(event) => setPublicQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void refreshPublicInfo(publicQuery, publicCategory); } }}
                  />
                  <button className="primary-button" disabled={publicLoading} onClick={() => void refreshPublicInfo(publicQuery, publicCategory)}>{publicLoading ? copy.campusPublicLoading : copy.campusPublicSearch}</button>
                </div>
                <div className="public-category-row">
                  {(['all', 'faculty', 'contact', 'program', 'labs'] as CampusPublicCategory[]).map((category) => (
                    <button key={category} className={publicCategory === category ? 'selected' : ''} onClick={() => setPublicCategory(category)}>
                      {category === 'all' ? '全部' : category === 'faculty' ? '师资' : category === 'contact' ? '联系方式' : category === 'program' ? '培养方案' : '实验室'}
                    </button>
                  ))}
                </div>
                {publicMessage && <p className="connection-message">{publicMessage}</p>}
                {publicInfo?.results.map((item) => (
                  <article className="campus-public-record" key={item.id}>
                    <strong>{item.name}</strong>
                    <span>{item.college} · {item.title}</span>
                    {item.phone && <small>电话：{item.phone}</small>}
                    {item.email && <small>邮箱：{item.email}</small>}
                    {item.profileUrl && <button className="notice-open-button" onClick={() => void openPublicInfoInBrowser(item.profileUrl)}>{copy.campusPublicOpen}</button>}
                  </article>
                ))}
                {publicInfo && publicInfo.results.length === 0 && <p className="empty-history">{copy.campusPublicEmpty}</p>}
                {publicInfo?.links.map((link) => (
                  <button className="notice-open-button" key={link.url} onClick={() => void openPublicInfoInBrowser(link.url)}>{link.title}</button>
                ))}
              </section>
            )}
            {campusTab === 'notices' && (
              <section className="profile-section campus-data-card campus-notices-card">
                <div className="setting-label"><strong>{copy.campusNotices}</strong><span>{copy.campusNoticeHint}</span></div>
                <div className="notice-search-row">
                  <input
                    value={noticeQuery}
                    placeholder={copy.campusNoticeSearchPlaceholder}
                    onChange={(event) => setNoticeQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void refreshNotices(noticeQuery, 1); } }}
                  />
                  <button className="primary-button" disabled={noticesLoading} onClick={() => void refreshNotices(noticeQuery, 1)}>{copy.campusNoticeSearch}</button>
                </div>
                {noticesMessage && <p className="connection-message">{noticesMessage}</p>}
                {notices.length > 0 && (
                  <div className="campus-notice-list">
                    {notices.map((notice) => (
                      <article className="campus-notice" key={notice.id}>
                        <div className="campus-notice-heading"><strong>{notice.title}</strong>{notice.pinned && <span>{copy.campusNotices}</span>}</div>
                        <p>{notice.summary || copy.campusNoticeHint}</p>
                        <small>{[notice.publisher, notice.publishedAt].filter(Boolean).join(' · ')}</small>
                        <button className="notice-open-button" onClick={() => void openNoticeInBrowser(notice.url)}>{copy.campusNoticeOpen}</button>
                      </article>
                    ))}
                  </div>
                )}
                {(noticesPage > 1 || notices.length >= 10 || noticesTotal > noticesPage * 10) && (
                  <div className="notice-pagination">
                    <button disabled={noticesLoading || noticesPage <= 1} onClick={() => void refreshNotices(noticeQuery, noticesPage - 1)}>{copy.campusNoticePrevious}</button>
                    <span>{noticesPage}{noticesTotal ? ` / ${Math.ceil(noticesTotal / 10)}` : ''}</span>
                    <button disabled={noticesLoading || (noticesTotal > 0 ? noticesPage * 10 >= noticesTotal : notices.length < 10)} onClick={() => void refreshNotices(noticeQuery, noticesPage + 1)}>{copy.campusNoticeNext}</button>
                  </div>
                )}
              </section>
            )}
          </div>
        </section>
      )}

      {mapOpen && <MapPanel language={state.profile.language} onClose={() => setMapOpen(false)} />}
      {weatherOpen && <WeatherPanel language={state.profile.language} onClose={() => setWeatherOpen(false)} />}
    </main>
  );
}
