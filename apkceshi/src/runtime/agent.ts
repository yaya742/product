import { buildSystemPrompt } from './prompt';
import {
  completeDeepSeek,
  type DeepSeekContent,
  type DeepSeekMessage,
  type DeepSeekToolCall,
  DeepSeekError,
} from './deepseek';
import { findWalkingRoute, loadMapData } from './map';
import { readPublicCollegeInfo, readPublicNotices } from './campus';
import { isMobileVmLocationAvailable, isMobileVmSession, mobileVmLocation } from './mobileVm';
import { CAMPUS_COORDINATE, fetchWeather, readDeviceLocation } from './weather';
import type { MobileAgendaItem, MobileAttachment, MobileCampusData, MobileConversation, MobileLanguage, MobileMessage, MobileReminder, MobileTurnControls } from './types';

export type AgentStatus = '联系 DeepSeek' | '读取手机时间' | '请求手机定位' | '查询天气' | '查询校园地图' | '规划路线' | '读取校园信息' | '读取课程活动' | '搜索校园公告' | '搜索院系公开资料' | '保存本地提醒' | '读取本地提醒' | '保存本地安排' | '读取本地安排' | '完成本地安排' | '撤销本地安排' | '搜索历史记录' | '保存长期记忆' | '整理回复';

export interface MobileAgentContext {
  conversations: MobileConversation[];
  agenda: MobileAgendaItem[];
  reminders: MobileReminder[];
  controls?: MobileTurnControls;
  allowMemoryWrite: boolean;
  allowLocalWrites: boolean;
  campus: MobileCampusData | null;
  readLearningActivities?: (courseId: string) => Promise<MobileCampusData['activities']>;
  currentAttachment?: MobileAttachment;
  createReminder: (input: { title: string; dueAt: string; notes: string }) => Promise<Record<string, unknown>>;
  prepareAction: (input: { title: string; detail: string; startsAt?: string; durationMinutes?: number }) => Promise<Record<string, unknown>>;
  updateAction: (id: string, status: 'done' | 'cancelled') => Promise<Record<string, unknown>>;
  saveMemory: (text: string) => Promise<Record<string, unknown>>;
}

function messageContent(message: MobileMessage): DeepSeekContent {
  if (message.attachment?.kind === 'image') {
    return [
      { type: 'text', text: message.content || `请分析图片附件：${message.attachment.name}` },
      { type: 'image_url', image_url: { url: message.attachment.dataUrl } },
    ];
  }
  if (message.attachment?.kind === 'text') {
    return `${message.content ? `${message.content}\n\n` : ''}[附件：${message.attachment.name}]\n${message.attachment.text}`;
  }
  return message.content;
}

function modelHistory(messages: MobileMessage[]): DeepSeekMessage[] {
  return messages
    .filter((message) => message.status !== 'running')
    .slice(-32)
    .map((message) => ({ role: message.role, content: messageContent(message) }));
}

function readLocation(signal: AbortSignal): Promise<Record<string, unknown>> {
  if (isMobileVmSession()) {
    if (!isMobileVmLocationAvailable()) return Promise.resolve({ status: 'unavailable', reason: '虚拟机已模拟定位不可用。' });
    const location = mobileVmLocation();
    return Promise.resolve({
      status: 'ok',
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy_m: location.accuracy,
      captured_at: new Date(location.timestamp).toISOString(),
      note: '这是虚拟机提供的紫金港测试位置，不会由本地运行时自动写入长期记忆。',
    });
  }
  if (!navigator.geolocation)
    return Promise.resolve({ status: 'unavailable', reason: '当前设备没有提供定位能力。' });
  return new Promise((resolve) => {
    const onAbort = () => resolve({ status: 'cancelled', reason: '用户停止了本轮定位。' });
    signal.addEventListener('abort', onAbort, { once: true });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        signal.removeEventListener('abort', onAbort);
        resolve({
          status: 'ok',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy_m: position.coords.accuracy,
          captured_at: new Date(position.timestamp).toISOString(),
          note: '这是一次性设备定位，不会由本地运行时自动写入长期记忆。',
        });
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ status: 'unavailable', reason: error.message || '设备没有返回当前位置。' });
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 },
    );
  });
}

function localTeacherMatches(query: string, campus: MobileCampusData | null) {
  if (!campus) return [];
  const needle = query.replace(/[\s·,，。！？!?、]/g, '').toLowerCase();
  if (!needle) return [];
  const seen = new Set<string>();
  return campus.courses.flatMap((course) => {
    const teacher = course.teacher.trim();
    const normalizedTeacher = teacher.replace(/[\s·,，。！？!?、]/g, '').toLowerCase();
    if (!normalizedTeacher || (!needle.includes(normalizedTeacher) && !normalizedTeacher.includes(needle))) return [];
    if (seen.has(normalizedTeacher)) return [];
    seen.add(normalizedTeacher);
    return [{
      id: `campus-course-teacher-${normalizedTeacher}`,
      name: teacher,
      college: '已同步校园课表',
      title: '课表中的授课教师',
      phone: '',
      email: '',
      profileUrl: '',
      sourceUrl: '',
      source: `已同步课表：${course.name}`,
    }];
  }).slice(0, 8);
}

async function runLocalTool(call: DeepSeekToolCall, signal: AbortSignal, context?: MobileAgentContext): Promise<Record<string, unknown>> {
  if (call.function.name === 'get_local_time') {
    return {
      status: 'ok',
      iso: new Date().toISOString(),
      local: new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(new Date()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
  if (call.function.name === 'get_device_location') return runLocalToolLocation(signal);
  if (call.function.name === 'get_weather') {
    let coordinate = CAMPUS_COORDINATE;
    let locationSource = '浙江大学紫金港校区参考位置';
    try {
      const location = await readDeviceLocation(signal);
      coordinate = location.coordinate;
      locationSource = `手机定位（误差约 ${Math.round(location.accuracy)} 米）`;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    const weather = await fetchWeather(coordinate, signal);
    return {
      status: 'ok',
      location_source: locationSource,
      coordinates: coordinate,
      timezone: weather.timezone,
      current: weather.current,
      hourly: weather.hourly,
      daily: weather.daily,
    };
  }
  if (call.function.name === 'search_campus_map') {
    const args = toolArguments(call);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { status: 'unavailable', reason: '没有提供要搜索的校园地点名称。' };
    const data = await loadMapData(signal);
    const needle = query.toLowerCase();
    const matches = data.places
      .filter((place) => [place.displayName, ...place.aliases].some((value) => value.toLowerCase().includes(needle)))
      .slice(0, 8);
    return {
      status: matches.length ? 'ok' : 'not_found',
      query,
      matches: matches.map((place) => ({
        name: place.displayName,
        aliases: place.aliases,
        kind: place.kind,
        coordinate: place.coordinate,
      })),
      reason: matches.length ? undefined : '本地校园地图没有找到这个名称，不能猜测建筑位置。',
    };
  }
  if (call.function.name === 'plan_campus_route') {
    const args = toolArguments(call);
    const originQuery = typeof args.origin === 'string' ? args.origin.trim() : '';
    const destinationQuery = typeof args.destination === 'string' ? args.destination.trim() : '';
    if (!originQuery || !destinationQuery) return { status: 'unavailable', reason: '请提供起点和终点。' };
    const data = await loadMapData(signal);
    async function resolvePlace(query: string) {
      if (query === '当前位置' || query.toLowerCase() === 'current location') {
        const current = await readDeviceLocation(signal);
        return { name: '当前位置', coordinate: current.coordinate };
      }
      const needle = query.toLowerCase();
      const match = data.places.find((place) => [place.displayName, ...place.aliases].some((value) => value.toLowerCase() === needle))
        || data.places.find((place) => [place.displayName, ...place.aliases].some((value) => value.toLowerCase().includes(needle)));
      return match ? { name: match.displayName, coordinate: match.coordinate } : undefined;
    }
    const origin = await resolvePlace(originQuery);
    const destination = await resolvePlace(destinationQuery);
    if (!origin || !destination) {
      return {
        status: 'not_found',
        origin: originQuery,
        destination: destinationQuery,
        reason: '起点或终点不在本地校园地图中。',
      };
    }
    const route = findWalkingRoute(data, origin.coordinate, destination.coordinate);
    return route
      ? { status: 'ok', origin: origin.name, destination: destination.name, distance_m: Math.round(route.meters), coordinates: route.coordinates }
      : { status: 'unavailable', origin: origin.name, destination: destination.name, reason: '本地步行路网没有找到连通路线。' };
  }
  if (call.function.name === 'get_campus_info') {
    if (!context?.campus) return { status: 'unavailable', reason: '手机端还没有读取校园信息，请先在个人设置的校园信息中填写账号并读取。' };
    return {
      status: 'ok',
      fetched_at: context.campus.fetchedAt,
      academic_year: context.campus.academicYear,
      term: context.campus.term,
      year_level: context.campus.yearLevel,
      gpa: context.campus.gpa,
      total_credit: context.campus.totalCredit,
      completed_credit: context.campus.completedCredit,
      earned_credit: context.campus.earnedCredit,
      schedule: context.campus.courses,
      courses: context.campus.courseOfferings,
      learning_courses: context.campus.learningCourses,
      activities: context.campus.activities,
      exams: context.campus.exams,
      grades: context.campus.grades,
      grade_alerts: context.campus.gradeAlerts,
      gpa_semesters: context.campus.gpaSemesters,
      gpa_cumulative: context.campus.gpaCumulative,
      todos: context.campus.todos,
      practice_summary: context.campus.practiceSummary,
      practice_projects: context.campus.practiceProjects,
      holidays: context.campus.holidays,
      source_status: context.campus.sourceStatus,
    };
  }
  if (call.function.name === 'get_course_activities') {
    if (!context?.readLearningActivities) return { status: 'unavailable', reason: '手机端没有配置学在浙大课程活动读取能力。' };
    const courseId = typeof toolArguments(call).course_id === 'string' ? String(toolArguments(call).course_id).trim() : '';
    if (!courseId) return { status: 'invalid', reason: '请提供学在浙大课程 ID。' };
    const activities = await context.readLearningActivities(courseId);
    return { status: activities.length ? 'ok' : 'not_found', course_id: courseId, activities, reason: activities.length ? undefined : '这门课程目前没有读取到活动。' };
  }
  if (call.function.name === 'search_campus_notices') {
    const args = toolArguments(call);
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 100) : '';
    const page = typeof args.page === 'number' && Number.isFinite(args.page) ? Math.trunc(args.page) : 1;
    const allowedCategories = ['all', 'profile', 'faculty', 'program', 'contact', 'labs'] as const;
    const category = allowedCategories.includes(args.category as typeof allowedCategories[number]) ? args.category as typeof allowedCategories[number] : 'all';
    const college = typeof args.college === 'string' ? args.college.trim().slice(0, 80) : '';
    const result = await readPublicNotices(query, page, { college, category, detail: args.detail === true });
    return {
      status: result.notices.length ? 'ok' : 'not_found',
      query,
      page: result.page,
      total_available: result.totalAvailable,
      notices: result.notices,
      reason: result.notices.length ? undefined : '官方公告中没有找到匹配内容。',
    };
  }
  if (call.function.name === 'create_local_reminder') {
    if (!context) return { status: 'unavailable', reason: '手机端提醒存储暂不可用。' };
    if (!context.allowLocalWrites) return { status: 'draft_only', reason: '本轮设置为不保存，提醒没有创建。' };
    const args = toolArguments(call);
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 120) : '';
    const dueAt = typeof args.due_at === 'string' ? args.due_at.trim() : '';
    const notes = typeof args.notes === 'string' ? args.notes.trim().slice(0, 500) : '';
    if (!title || !dueAt || Number.isNaN(Date.parse(dueAt)) || Date.parse(dueAt) <= Date.now())
      return { status: 'invalid', reason: '提醒标题或时间无效，时间必须是未来时间。' };
    return context.createReminder({ title, dueAt: new Date(dueAt).toISOString(), notes });
  }
  if (call.function.name === 'list_local_reminders') {
    if (!context) return { status: 'unavailable', reason: '手机端提醒存储暂不可用。' };
    return {
      status: 'ok',
      reminders: context.reminders
        .filter((reminder) => !reminder.completed && Date.parse(reminder.dueAt) >= Date.now() - 60_000)
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        .slice(0, 30)
      .map(({ id, title, notes, dueAt }) => ({ id, title, notes, due_at: dueAt })),
    };
  }
  if (call.function.name === 'search_college_public_info') {
    const args = toolArguments(call);
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 80) : '';
    const allowedCategories = ['all', 'profile', 'faculty', 'program', 'contact', 'labs'] as const;
    const category = allowedCategories.includes(args.category as typeof allowedCategories[number])
      ? args.category as typeof allowedCategories[number]
      : 'all';
    if (!query) return { status: 'unavailable', reason: '没有提供要查询的教师或院系名称。' };
    const result = await readPublicCollegeInfo(query, category);
    if (result.results.length || !context?.campus) return { ...result };
    const localResults = localTeacherMatches(query, context.campus);
    if (!localResults.length) return { ...result };
    return {
      ...result,
      status: 'ok',
      results: localResults,
      reason: '已在同步校园课表中找到授课教师，但浙江大学教师个人主页门户没有找到对应公开主页或联系方式。',
    };
  }
  if (call.function.name === 'prepare_action') {
    if (!context) return { status: 'unavailable', reason: '手机端本地安排存储暂不可用。' };
    if (!context.allowLocalWrites) return { status: 'draft_only', reason: '本轮设置为不保存，本地安排没有登记。' };
    const args = toolArguments(call);
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 160) : '';
    const detail = typeof args.detail === 'string' ? args.detail.trim().slice(0, 500) : '';
    const startsAt = typeof args.starts_at === 'string' && !Number.isNaN(Date.parse(args.starts_at))
      ? new Date(args.starts_at).toISOString()
      : undefined;
    const durationMinutes = typeof args.duration_minutes === 'number' && Number.isFinite(args.duration_minutes)
      ? Math.max(1, Math.min(24 * 60, Math.round(args.duration_minutes)))
      : undefined;
    if (!title) return { status: 'invalid', reason: '本地安排需要标题。' };
    return context.prepareAction({ title, detail, ...(startsAt ? { startsAt } : {}), ...(durationMinutes ? { durationMinutes } : {}) });
  }
  if (call.function.name === 'list_local_actions') {
    if (!context) return { status: 'unavailable', reason: '手机端本地安排存储暂不可用。' };
    const includeDone = toolArguments(call).include_done === true;
    const actions = context.agenda
      .filter((item) => item.status !== 'cancelled' && (includeDone || item.status !== 'done'))
      .slice(-30)
      .map(({ id, title, detail, startsAt, durationMinutes, status }) => ({ id, title, detail, starts_at: startsAt, duration_minutes: durationMinutes, status }));
    return { status: 'ok', actions };
  }
  if (call.function.name === 'complete_local_action' || call.function.name === 'cancel_local_action') {
    if (!context) return { status: 'unavailable', reason: '手机端本地安排存储暂不可用。' };
    if (!context.allowLocalWrites) return { status: 'draft_only', reason: '本轮设置为不保存，本地安排没有修改。' };
    const id = typeof toolArguments(call).action_id === 'string' ? String(toolArguments(call).action_id).trim() : '';
    if (!id) return { status: 'invalid', reason: '没有提供本地安排 ID。' };
    const action = context.agenda.find((item) => item.id === id);
    if (!action) return { status: 'known_absent', reason: '没有找到这项本地安排。' };
    return context.updateAction(id, call.function.name === 'complete_local_action' ? 'done' : 'cancelled');
  }
  if (call.function.name === 'search_local_history') {
    if (!context) return { status: 'unavailable', reason: '手机端历史记录暂不可用。' };
    const query = typeof toolArguments(call).query === 'string' ? String(toolArguments(call).query).trim().toLowerCase() : '';
    if (!query) return { status: 'invalid', reason: '没有提供搜索内容。' };
    const results = context.conversations.flatMap((conversation) => conversation.messages
      .filter((message) => message.content.toLowerCase().includes(query))
      .map((message) => ({
        conversation: conversation.title,
        role: message.role === 'user' ? '用户' : '在场',
        time: message.createdAt,
        excerpt: message.content.slice(0, 500),
      }))).slice(-20);
    return { status: results.length ? 'ok' : 'not_found', query, results };
  }
  if (call.function.name === 'save_memory') {
    if (!context) return { status: 'unavailable', reason: '手机端记忆存储暂不可用。' };
    if (!context.allowMemoryWrite) return { status: 'draft_only', reason: '本轮设置为不形成长期记忆，这条内容没有保存。' };
    const text = typeof toolArguments(call).text === 'string' ? String(toolArguments(call).text).trim().slice(0, 300) : '';
    if (!text) return { status: 'invalid', reason: '没有提供要保存的内容。' };
    return context.saveMemory(text);
  }
  return { status: 'unavailable', reason: '手机端没有提供这项能力。' };
}

function toolArguments(call: DeepSeekToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function runLocalToolLocation(signal: AbortSignal): Promise<Record<string, unknown>> {
  return readLocation(signal);
}

export async function runMobileAgent(
  apiKey: string,
  messages: MobileMessage[],
  userText: string,
  memories: string[],
  language: MobileLanguage,
  signal: AbortSignal,
  onText: (text: string) => void,
  onStatus: (status: AgentStatus) => void,
  context?: MobileAgentContext,
  controls: MobileTurnControls = { memoryMode: 'relevant', retention: 'purpose_scoped', audience: 'self' },
): Promise<string> {
  const wire: DeepSeekMessage[] = [
    { role: 'system', content: buildSystemPrompt(memories, language, controls) },
    ...(controls.memoryMode === 'relevant' ? modelHistory(messages) : []),
    { role: 'user', content: context?.currentAttachment ? messageContent({
      id: 'current-user',
      role: 'user',
      content: userText,
      attachment: context.currentAttachment,
      createdAt: new Date().toISOString(),
      status: 'done',
    }) : userText },
  ];
  for (let round = 0; round < 6; round++) {
    signal.throwIfAborted();
    onStatus(round === 0 ? '联系 DeepSeek' : '整理回复');
    let streamedText = '';
    const completion = await completeDeepSeek(apiKey, wire, signal, undefined, (text) => {
      streamedText += text;
    });
    wire.push(completion.message);
    if (!completion.message.tool_calls?.length) {
      const finalText = typeof completion.message.content === 'string' ? completion.message.content : '';
      const visibleText = streamedText || finalText;
      if (visibleText) onText(visibleText);
      return visibleText || '这次没有返回可显示的内容。';
    }

    for (const call of completion.message.tool_calls) {
      signal.throwIfAborted();
      onStatus(
        call.function.name === 'get_local_time'
          ? '读取手机时间'
          : call.function.name === 'get_weather'
            ? '查询天气'
            : call.function.name === 'search_campus_map'
              ? '查询校园地图'
              : call.function.name === 'plan_campus_route'
                ? '规划路线'
                : call.function.name === 'get_campus_info'
                  ? '读取校园信息'
                : call.function.name === 'get_course_activities'
                  ? '读取课程活动'
                : call.function.name === 'search_campus_notices'
                  ? '搜索校园公告'
                : call.function.name === 'search_college_public_info'
                  ? '搜索院系公开资料'
                : call.function.name === 'create_local_reminder'
                  ? '保存本地提醒'
                  : call.function.name === 'list_local_reminders'
                    ? '读取本地提醒'
                    : call.function.name === 'prepare_action'
                      ? '保存本地安排'
                      : call.function.name === 'list_local_actions'
                        ? '读取本地安排'
                        : call.function.name === 'complete_local_action'
                          ? '完成本地安排'
                          : call.function.name === 'cancel_local_action'
                            ? '撤销本地安排'
                            : call.function.name === 'search_local_history'
                      ? '搜索历史记录'
                      : call.function.name === 'save_memory'
                        ? '保存长期记忆'
                        : '请求手机定位',
      );
      let result: Record<string, unknown>;
      try {
        result = await runLocalTool(call, signal, context);
      } catch (error) {
        result = {
          status: 'unavailable',
          reason: error instanceof Error ? error.message : '手机能力调用失败。',
        };
      }
      wire.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: call.id });
    }
  }
  throw new DeepSeekError('本轮工具处理次数达到上限，请把问题说得更具体一些。', 'protocol');
}
