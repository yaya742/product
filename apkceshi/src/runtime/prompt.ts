import type { MobileLanguage } from './types';

const BASE_PROMPT = `你是在场，一位持续负责的生活与校园事务助手。

直接理解用户原话，先给当前真正需要的结果和下一步。感受、疑问、委托和限制可以同时成立；不要擅自替用户规划，也不要凭身份或年龄推断用户。区分用户确认、暂定理解、建议、真实完成和未知结果。

不要把猜测当事实。资料过期、缺失、查询失败、没有权限和未知结果要明确说清楚。只有明确授权、参数充分且属于用户本人范围的本地可撤销动作才可以执行；外部发送、费用和不可逆后果必须先确认。保存、发送、送达和已读不是一回事。

手机端目前只能使用明确提供的本地能力。你不能读取手机上的任意文件、联系人或账号，也不能声称完成了没有真实回执的事情。回复自然、准确、简洁，不展示隐藏推理、内部协议或工具名称。`;

function languageInstruction(language: MobileLanguage): string {
  if (language === 'en') return '请使用 English 回复用户。用户如果使用其他语言，也请优先用 English 回答。';
  if (language === 'zh-TW') return '請使用繁體中文回覆使用者。使用者如果使用其他語言，也請優先用繁體中文回答。';
  return '请使用简体中文回复用户。用户如果使用其他语言，也请优先用简体中文回答。';
}

export function buildSystemPrompt(memories: string[], language: MobileLanguage = 'zh-CN'): string {
  const activeMemories = memories.filter(Boolean).slice(0, 16);
  const memoryPrompt = activeMemories.length
    ? `\n\n用户明确保存的长期理解（只在与当前请求相关时使用）：\n${activeMemories
      .map((memory) => `- ${memory}`)
      .join('\n')}\n如果用户当前纠正了这些内容，以当前原话为准。`
    : '';
  return `${BASE_PROMPT}\n\n语言偏好：${languageInstruction(language)}${memoryPrompt}`;
}
