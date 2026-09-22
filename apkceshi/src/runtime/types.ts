export type MobileMessageRole = 'user' | 'assistant';
export type MobileLanguage = 'zh-CN' | 'zh-TW' | 'en';
export type MobileTheme = 'light' | 'dark';
export type MobileMemoryMode = 'relevant' | 'current_sources_only' | 'none';
export type MobileRetention = 'purpose_scoped' | 'history_no_inference' | 'session_only';
export type MobileAudience = 'self' | 'group' | 'public';

export interface MobileTurnControls {
  memoryMode: MobileMemoryMode;
  retention: MobileRetention;
  audience: MobileAudience;
}

export type MobileAttachment =
  | {
      kind: 'image';
      name: string;
      mimeType: 'image/jpeg';
      dataUrl: string;
      width: number;
      height: number;
    }
  | {
      kind: 'text';
      name: string;
      text: string;
    };

export interface MobileReminder {
  id: string;
  title: string;
  notes: string;
  dueAt: string;
  createdAt: string;
  completed: boolean;
  notificationId: number;
}

export type MobileAgendaStatus = 'saved' | 'done' | 'cancelled';

export interface MobileAgendaItem {
  id: string;
  title: string;
  detail: string;
  startsAt?: string;
  durationMinutes?: number;
  createdAt: string;
  status: MobileAgendaStatus;
  source: 'assistant' | 'user';
}

export interface CampusCourse {
  id: string;
  name: string;
  teacher: string;
  location: string;
  time: string;
  /** Numeric timetable fields retained for deterministic sorting and display. */
  weekday?: number;
  startPeriod?: number;
  endPeriod?: number;
  weeks: string;
  credit: string;
  score: string;
  completed: boolean;
}

export interface CampusCourseOffering {
  id: string;
  name: string;
  semesterId: string;
  credit: string;
  teachers: string;
  confirmed: boolean | null;
  online: boolean | null;
}

export interface CampusLearningCourse {
  id: string;
  name: string;
  code: string;
  teachers: string;
  term: string;
  credit: string;
  status: string;
}

export interface CampusActivity {
  id: string;
  courseId: string;
  title: string;
  type: string;
  startTime: string;
  endTime: string;
  deadline: string;
  status: string;
  url: string;
}

export interface CampusExam {
  id: string;
  name: string;
  time: string;
  location: string;
  seat: string;
  type: string;
  status: 'upcoming' | 'finished' | 'unknown';
}

export interface CampusGrade {
  id: string;
  name: string;
  score: string;
  credit: string;
  point: string;
  semesterId?: string;
  courseKey?: string;
  creditIncluded?: boolean;
  gpaIncluded?: boolean;
  gpaExclusionReason?: string;
}

export interface CampusGradeAlert {
  id: string;
  courseKey: string;
  name: string;
  credit: string;
  score: string;
  point: string;
  level: 'failed' | 'attention';
  note: string;
}

export interface CampusGpaSummary {
  semesterId?: string;
  throughSemester: string;
  gpa: number | null;
  creditDenominator: number;
  eligibleAttempts: number;
  countedAttempts: number;
  excludedAttempts: number;
  complete: boolean;
  note: string;
}

export interface CampusHoliday {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  kind: string;
  note: string;
  source: string;
}

export interface CampusSourceStatus {
  available: boolean;
  credentialsConfigured: boolean;
  authStatus: string;
  supportedDomains: string[];
  note: string;
}

export interface CampusTodo {
  id: string;
  name: string;
  course: string;
  deadline: string;
  status: string;
}

export interface CampusPracticeSummary {
  secondClassPoints: number | null;
  thirdClassPoints: number | null;
  fourthClassPoints: number | null;
  aestheticEducationPassed: boolean | null;
  laborEducationPassed: boolean | null;
  source: string;
}

export interface CampusPracticeProject {
  id: string;
  name: string;
  category: string;
  projectType: string;
  qualityType: string;
  score: number | null;
  status: string;
  approved: boolean;
  role: string;
  remark: string;
  activityTime: string;
}

export interface CampusNotice {
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  summary: string;
  url: string;
  pinned: boolean;
  category?: string;
  detail?: string;
  detailSource?: string;
}

export type CampusPublicCategory = 'all' | 'profile' | 'faculty' | 'program' | 'contact' | 'labs';

export interface CampusPublicInfo {
  id: string;
  name: string;
  college: string;
  title: string;
  phone: string;
  email: string;
  profileUrl: string;
  sourceUrl: string;
  source: string;
}

export interface MobileCampusData {
  fetchedAt: string;
  academicYear: string;
  term: string;
  courses: CampusCourse[];
  courseOfferings: CampusCourseOffering[];
  learningCourses: CampusLearningCourse[];
  activities: CampusActivity[];
  exams: CampusExam[];
  grades: CampusGrade[];
  gradeAlerts: CampusGradeAlert[];
  gpaSemesters: CampusGpaSummary[];
  gpaCumulative: CampusGpaSummary | null;
  todos: CampusTodo[];
  practiceSummary: CampusPracticeSummary | null;
  practiceProjects: CampusPracticeProject[];
  gpa: number | null;
  totalCredit: number;
  completedCredit: number;
  earnedCredit: number;
  yearLevel: string;
  holidays: CampusHoliday[];
  sourceStatus: CampusSourceStatus;
  warnings: string[];
}

export interface MobileMessage {
  id: string;
  role: MobileMessageRole;
  content: string;
  attachment?: MobileAttachment;
  translations?: Partial<Record<MobileLanguage, string>>;
  ephemeral?: boolean;
  createdAt: string;
  status: 'running' | 'done' | 'error';
}

export interface MobileConversation {
  id: string;
  title: string;
  messages: MobileMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface MobileProfile {
  avatar: string;
  language: MobileLanguage;
  theme: MobileTheme;
  studentId: string;
  studentPassword: string;
}

export interface MobileState {
  apiKey: string;
  conversations: MobileConversation[];
  activeConversationId: string;
  memories: string[];
  agenda: MobileAgendaItem[];
  reminders: MobileReminder[];
  campus: MobileCampusData | null;
  profile: MobileProfile;
}

export const DEFAULT_PROFILE: MobileProfile = {
  avatar: '在',
  language: 'zh-CN',
  theme: 'light',
  studentId: '',
  studentPassword: '',
};

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createConversation(title = '新对话'): MobileConversation {
  const now = new Date().toISOString();
  return { id: newId('conversation'), title, messages: [], createdAt: now, updatedAt: now };
}

export function createInitialState(): MobileState {
  const conversation = createConversation();
  return {
    apiKey: '',
    conversations: [conversation],
    activeConversationId: conversation.id,
    memories: [],
    agenda: [],
    reminders: [],
    campus: null,
    profile: { ...DEFAULT_PROFILE },
  };
}

export const EMPTY_MOBILE_STATE: MobileState = createInitialState();
