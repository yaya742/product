import { randomUUID } from 'node:crypto';
import type { Message, Step } from '../shared/types';
import { emptyRoute, type MapCard } from '../shared/map-v2';
import type { CampusMapAdapter } from './mapService';

async function pause(signal: AbortSignal, ms = 420) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function runDemo(
  input: string,
  m: Message,
  signal: AbortSignal,
  step: (s: Step) => void,
  publish: () => void,
  map?: CampusMapAdapter,
  mapCard?: (card: MapCard) => void,
) {
  const mapIntent = /地图|怎么走|路线|步行|从.+到|位置|在哪儿|map|route|walk/i.test(input);
  const sports = /羽毛球|打卡|运动/.test(input),
    tired = /累|焦虑|休息|难受|情绪/.test(input),
    history = /历史|以前|之前|记得/.test(input);
  const steps = mapIntent
    ? ['识别起点和目的地', '核对本地校园路网', '只显示这一条候选路线']
    : history
    ? ['展示按需查找旧对话的方式', '说明历史记录的使用范围']
    : sports
      ? ['梳理时间与运动需求', '演示课表、天气两个调查方向', '把建议留给你决定']
      : tired
        ? ['先照顾你现在的感受', '把下一步缩小一点']
        : ['把眼前的事拆成小步骤', '演示如何结合空闲时间与偏好', '留出可以调整的余地'];
  m.obligations = steps.map((title, i) => ({ id: String(i), title, status: 'pending' }));
  publish();
  for (let i = 0; i < steps.length; i++) {
    const id = randomUUID();
    m.obligations[i].status = 'running';
    step({ id, title: steps[i], status: 'running', detail: '本地交互演示，未调用模型或个人数据' });
    await pause(signal);
    m.obligations[i].status = 'done';
    step({ id, title: steps[i], status: 'done', detail: '示例步骤' });
  }
  if (mapIntent && map && mapCard) mapCard({kind:'route',route:emptyRoute('打开地图后选择目的地；无需等待模型，即可直接操作。')});
  let text: string, title: string, detail: string;
  if (mapIntent) {
    text = '校园地图可以直接打开了。你可以搜索或点选建筑，也可以用“两点路线”先选起点，再选终点。\n\n地图使用开放矢量数据；入口或连接缺失时会明确说明。位置来自本机 Windows 服务，未连接手机，也不会把示例地点当作你的当前位置。';
    title = '';
    detail = '';
  } else if (tired) {
    text =
      '那就先不把今天安排得更满。\n\n放下手里的事，喝点水，给自己 **十分钟不需要完成任何事的时间**。回来后，只选一件小事就够了。\n\n如果你愿意，也可以说说：是身体有点累，还是心里装了太多事？';
    title = '先给自己十分钟';
    detail = '不赶进度，也不需要把休息变成另一项任务。';
  } else if (sports) {
    text =
      '把运动留进生活里，是个好主意。\n\n我会先对照你的**逐次课程和考试**，再看天气与地点，帮你找一段不用来回赶的时间。场地有无空位，需要预约系统的实时结果。\n\n现在还没有连接你的校园资料，因此不能判断下周哪天有空，也没有提交预约。可以先记下这件事，接入资料后再一起定时间。';
    title = /打卡/.test(input) ? '核对本学期打卡次数与截止日' : '找一个空闲时段打羽毛球';
    detail = '先核对课表，再查场地。具体时间和预约结果待确认。';
  } else if (history) {
    text =
      '重要的偏好只记一点点，需要细节时，再翻看相关的旧对话。\n\n每条记忆都可以查看、更正或删除。连接 DeepSeek 后，我会按你的问题搜索本机记录，并告诉你用到了什么。\n\n这段是本地体验说明，没有读取你的其他应用或外部聊天记录。';
    title = '';
    detail = '';
  } else {
    text =
      '先不用把一整天都安排好。\n\n如果接下来有一段空闲，可以把它留给**一件最想推进的事**。先专心做 45 分钟，再停下来走走；做完后，我们再看下一步。\n\n这是一个可以修改的示例。连接 DeepSeek 并导入校园资料后，我才能结合你的真实课程、偏好和截止时间来安排。';
    title = '留出 45 分钟，专心做一件事';
    detail = '选一件眼前重要的事。把其他安排暂时放下，结束后休息 10 分钟。';
  }
  for (const part of text.match(/.{1,18}|\n/g) || []) {
    await pause(signal, 12);
    m.content += part;
    publish();
  }
  if (title) {
    m.actions.push({ id: randomUUID(), title, detail, durationMinutes: tired ? 10 : 45, demo: true });
    publish();
  }
}
