export interface CampusTodoAttachment {
  name: string;
  url?: string;
}

export interface CampusTodoDetails {
  description?: string;
  submissionRequirements?: string;
  attachments: CampusTodoAttachment[];
  sourceUrl?: string;
  updatedAt?: string;
}

const COURSES_HOME = 'https://courses.zju.edu.cn/user/index';
const COURSE_ACTIVITY_PAGE = 'https://courses.zju.edu.cn/course/{courseId}/learning-activity#/{activityId}';
const TEXT_VALUE_KEYS = ['name', 'filename', 'file_name', 'title', 'text', 'value', 'label'];

function valueText(value: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map((item) => valueText(item, depth + 1)).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of TEXT_VALUE_KEYS) {
    const text = valueText(record[key], depth + 1);
    if (text) return text;
  }
  return '';
}

function displayText(value: unknown): string {
  return valueText(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/[\t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, 8000);
}

export function normalizeOfficialCourseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return undefined;
  try {
    const url = new URL(value.trim(), COURSES_HOME);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'courses.zju.edu.cn') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function officialActivityUrl(courseId: string, activityId: string): string | undefined {
  if (!/^\d{1,20}$/.test(courseId) || !/^\d{1,20}$/.test(activityId)) return undefined;
  return normalizeOfficialCourseUrl(COURSE_ACTIVITY_PAGE
    .replace('{courseId}', encodeURIComponent(courseId))
    .replace('{activityId}', encodeURIComponent(activityId)));
}

function attachmentUrl(record: Record<string, unknown>): string | undefined {
  const directUrl = normalizeOfficialCourseUrl(record.url ?? record.href ?? record.link);
  if (directUrl) return directUrl;
  const referenceId = record.reference_id;
  const normalizedReferenceId = typeof referenceId === 'number' && Number.isSafeInteger(referenceId)
    ? String(referenceId)
    : typeof referenceId === 'string' ? referenceId.trim() : '';
  if (!/^\d{1,30}$/.test(normalizedReferenceId)) return undefined;
  return `https://courses.zju.edu.cn/api/uploads/reference/${encodeURIComponent(normalizedReferenceId)}/blob`;
}

function normalizeAttachments(value: unknown): CampusTodoAttachment[] {
  const items = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return items.flatMap((item): CampusTodoAttachment[] => {
    const record = typeof item === 'string' ? { name: item } : item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
    if (!record) return [];
    const url = attachmentUrl(record);
    const name = displayText(record.name ?? record.filename ?? record.file_name ?? record.title ?? (typeof item === 'string' ? item : ''));
    if (!name && !url) return [];
    return [{ name: (name || '附件').slice(0, 240), ...(url ? { url } : {}) }];
  }).slice(0, 20);
}

function firstText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = displayText(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function normalizeTodoDetails(record: Record<string, unknown>): CampusTodoDetails {
  const officialData = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined;
  const description = (officialData ? firstText(officialData, ['description']) : undefined)
    || firstText(record, ['description', 'instructions', 'content', 'brief', 'requirement', 'requirements']);
  const submissionRequirements = firstText(record, [
    'submission_requirements', 'submissionRequirements', 'submission_requirement', 'submit_requirement', 'submitRequirement', 'submission_instructions',
  ]);
  const rawAttachments = record.upload_references ?? record.attachments ?? record.attachment_list ?? record.attachmentList ?? record.assignment_attachments;
  const attachments = normalizeAttachments(rawAttachments);
  const sourceUrl = normalizeOfficialCourseUrl(record.url ?? record.href ?? record.link ?? record.detail_url ?? record.detailUrl);
  const updatedAt = firstText(record, ['updated_at', 'updatedAt', 'update_time', 'updateTime']);
  return {
    ...(description ? { description } : {}),
    ...(submissionRequirements ? { submissionRequirements } : {}),
    attachments,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}
