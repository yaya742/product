import type { MobileLanguage } from './types';

export interface UiCopy {
  appName: string;
  connected: string;
  waiting: string;
  offline: string;
  history: string;
  settings: string;
  newConversation: string;
  onlineKicker: string;
  welcomeTitle: string;
  welcomeBody: string;
  suggestions: string[];
  ready: string;
  needKey: string;
  privacy: string;
  stop: string;
  settingsEyebrow: string;
  profileTitle: string;
  close: string;
  secureNote: string;
  apiKey: string;
  testConnection: string;
  testing: string;
  connectionSuccess: string;
  memoryEyebrow: string;
  memoryTitle: string;
  memoryPlaceholder: string;
  save: string;
  historyTitle: string;
  historyEmpty: string;
  rename: string;
  delete: string;
  renamePlaceholder: string;
  cancel: string;
  done: string;
  profileEyebrow: string;
  avatar: string;
  avatarHint: string;
  language: string;
  appearance: string;
  light: string;
  dark: string;
  campus: string;
  campusHint: string;
  campusTitle: string;
  studentId: string;
  studentPassword: string;
  passwordPlaceholder: string;
  saved: string;
  translatingConversation: string;
  translatedConversation: string;
  translationNeedKey: string;
  translationFailed: string;
  back: string;
  contacting: string;
  readingTime: string;
  locating: string;
  composing: string;
  assistant: string;
  user: string;
  typing: string;
  draftPlaceholder: string;
  titleFallback: string;
  attachFile: string;
  removeAttachment: string;
  attachmentTooLarge: string;
  attachmentInvalid: string;
  imageReady: string;
  textAttachmentReady: string;
  reminders: string;
  remindersHint: string;
  remindersTitle: string;
  reminderEmpty: string;
  reminderTitle: string;
  reminderNotes: string;
  reminderTime: string;
  addReminder: string;
  complete: string;
  reminderSaved: string;
  notificationDenied: string;
  webReminderNote: string;
  memoryRemove: string;
  historySearchPlaceholder: string;
}

const SIMPLIFIED: UiCopy = {
  appName: '在场',
  connected: '已连接',
  waiting: '等待连接',
  offline: '无网络',
  history: '历史对话',
  settings: '设置',
  newConversation: '新对话',
  onlineKicker: '在场 · 随时在线',
  welcomeTitle: '把此刻，放在这里。',
  welcomeBody: '说说你正在经历的事。我会先听懂，再陪你找到下一步。',
  suggestions: ['帮我理一下今天要做的事', '我现在在哪里？', '给我一个简单的学习安排'],
  ready: '本机已准备好',
  needKey: '先在设置里连接 DeepSeek',
  privacy: '直连 DeepSeek · 对话、记忆和 Key 保存在本机',
  stop: '停止',
  settingsEyebrow: '设置',
  profileTitle: '让在场更懂你',
  close: '关闭',
  secureNote: '你的 Key 只保存在这台设备，消息直接发送到 DeepSeek。',
  apiKey: 'DeepSeek API Key',
  testConnection: '测试连接',
  testing: '测试中',
  connectionSuccess: '连接成功。Key 只保存在这台设备。',
  memoryEyebrow: '长期记忆',
  memoryTitle: '告诉我一些关于你的事',
  memoryPlaceholder: '例如：我喜欢简洁的安排',
  save: '保存',
  historyTitle: '历史对话',
  historyEmpty: '还没有历史对话',
  rename: '修改标题',
  delete: '删除',
  renamePlaceholder: '输入新的标题',
  cancel: '取消',
  done: '完成',
  profileEyebrow: '个人设置',
  avatar: '头像',
  avatarHint: '从相册选择一张图片作为头像',
  language: '语言',
  appearance: '外观',
  light: '浅色',
  dark: '深色',
  campus: '校园信息',
  campusHint: '学号和密码仅保存在本机',
  campusTitle: '校园信息',
  studentId: '学号',
  studentPassword: '密码',
  passwordPlaceholder: '输入校园密码',
  saved: '已保存',
  translatingConversation: '正在翻译当前对话…',
  translatedConversation: '对话语言已切换。',
  translationNeedKey: '切换对话语言需要先配置 DeepSeek API Key。',
  translationFailed: '部分消息翻译失败，已保留原文。',
  back: '返回',
  contacting: '联系 DeepSeek',
  readingTime: '读取手机时间',
  locating: '请求手机定位',
  composing: '整理回复',
  assistant: '在场',
  user: '你',
  typing: '正在整理…',
  draftPlaceholder: '说说眼前的事…',
  titleFallback: '未命名对话',
  attachFile: '添加附件',
  removeAttachment: '移除附件',
  attachmentTooLarge: '附件太大，请选择较小的文件。',
  attachmentInvalid: '暂不支持这个文件，请选择图片或文字文件。',
  imageReady: '请看看这张图片',
  textAttachmentReady: '请阅读这个文字附件',
  reminders: '日程提醒',
  remindersHint: '只保存在本机，到时间提醒你',
  remindersTitle: '日程提醒',
  reminderEmpty: '还没有安排提醒',
  reminderTitle: '提醒内容',
  reminderNotes: '备注（可选）',
  reminderTime: '提醒时间',
  addReminder: '添加提醒',
  complete: '完成',
  reminderSaved: '已保存到本机',
  notificationDenied: '已保存，但系统通知权限未开启。',
  webReminderNote: '浏览器预览不会发送系统通知，安装 APK 后才会提醒。',
  memoryRemove: '移除记忆',
  historySearchPlaceholder: '搜索历史对话',
};

const TRADITIONAL: UiCopy = {
  ...SIMPLIFIED,
  connected: '已連接', waiting: '等待連接', offline: '無網絡', history: '歷史對話',
  settings: '設定', newConversation: '新對話', onlineKicker: '在場 · 隨時在線',
  welcomeTitle: '把此刻，放在這裏。', welcomeBody: '說說你正在經歷的事。我會先聽懂，再陪你找到下一步。',
  suggestions: ['幫我理一下今天要做的事', '我現在在哪裏？', '給我一個簡單的學習安排'],
  ready: '本機已準備好', needKey: '先在設定裏連接 DeepSeek', privacy: '直連 DeepSeek · 對話、記憶和 Key 保存在本機',
  stop: '停止', settingsEyebrow: '設定', profileTitle: '讓在場更懂你', close: '關閉',
  secureNote: '你的 Key 只保存在這台裝置，訊息直接發送到 DeepSeek。', apiKey: 'DeepSeek API Key',
  testConnection: '測試連接', testing: '測試中', connectionSuccess: '連接成功。Key 只保存在這台裝置。',
  memoryEyebrow: '長期記憶', memoryTitle: '告訴我一些關於你的事', memoryPlaceholder: '例如：我喜歡簡潔的安排', save: '儲存',
  historyTitle: '歷史對話', historyEmpty: '還沒有歷史對話', rename: '修改標題', delete: '刪除',
  renamePlaceholder: '輸入新的標題', cancel: '取消', done: '完成', profileEyebrow: '個人設定', avatar: '頭像',
  avatarHint: '從相簿選擇一張圖片作為頭像', language: '語言', appearance: '外觀', light: '淺色', dark: '深色',
  campus: '校園資訊', campusHint: '學號和密碼僅保存在本機', campusTitle: '校園資訊', studentId: '學號',
  studentPassword: '密碼', passwordPlaceholder: '輸入校園密碼', saved: '已儲存',
  translatingConversation: '正在翻譯目前對話…', translatedConversation: '對話語言已切換。', translationNeedKey: '切換對話語言需要先設定 DeepSeek API Key。', translationFailed: '部分訊息翻譯失敗，已保留原文。', back: '返回',
  contacting: '聯絡 DeepSeek', readingTime: '讀取手機時間', locating: '請求手機定位', composing: '整理回覆',
  assistant: '在場', user: '你', typing: '正在整理…', draftPlaceholder: '說說眼前的事…', titleFallback: '未命名對話',
  attachFile: '添加附件', removeAttachment: '移除附件', attachmentTooLarge: '附件太大，請選擇較小的檔案。', attachmentInvalid: '暫不支援這個檔案，請選擇圖片或文字檔案。',
  imageReady: '請看看這張圖片', textAttachmentReady: '請閱讀這個文字附件', reminders: '日程提醒', remindersHint: '只保存在本機，到時間提醒你', remindersTitle: '日程提醒', reminderEmpty: '還沒有安排提醒',
  reminderTitle: '提醒內容', reminderNotes: '備註（可選）', reminderTime: '提醒時間', addReminder: '添加提醒', complete: '完成', reminderSaved: '已儲存到本機', notificationDenied: '已儲存，但系統通知權限未開啟。', webReminderNote: '瀏覽器預覽不會發送系統通知，安裝 APK 後才會提醒。', memoryRemove: '移除記憶', historySearchPlaceholder: '搜尋歷史對話',
};

const ENGLISH: UiCopy = {
  ...SIMPLIFIED,
  appName: 'Zaichang', connected: 'Connected', waiting: 'Waiting', offline: 'Offline', history: 'History',
  settings: 'Settings', newConversation: 'New chat', onlineKicker: 'Zaichang · Always here',
  welcomeTitle: 'Put this moment here.', welcomeBody: 'Tell me what you are going through. I will listen first, then help you find the next step.',
  suggestions: ['Help me plan today', 'Where am I right now?', 'Make me a simple study plan'], ready: 'Ready on this device',
  needKey: 'Connect DeepSeek in Settings', privacy: 'Direct to DeepSeek · Your chats, memories and key stay on this device', stop: 'Stop',
  settingsEyebrow: 'Settings', profileTitle: 'Make Zaichang yours', close: 'Close', secureNote: 'Your key stays on this device and messages go directly to DeepSeek.',
  apiKey: 'DeepSeek API Key', testConnection: 'Test connection', testing: 'Testing', connectionSuccess: 'Connected. Your key stays on this device.',
  memoryEyebrow: 'Long-term memory', memoryTitle: 'Tell me something about you', memoryPlaceholder: 'For example: I like simple plans', save: 'Save',
  historyTitle: 'Chat history', historyEmpty: 'No conversations yet', rename: 'Rename', delete: 'Delete', renamePlaceholder: 'Enter a new title',
  cancel: 'Cancel', done: 'Done', profileEyebrow: 'Profile settings', avatar: 'Avatar', avatarHint: 'Choose an image from your gallery', language: 'Language',
  appearance: 'Appearance', light: 'Light', dark: 'Dark', campus: 'Campus information', campusHint: 'Student ID and password stay on this device', campusTitle: 'Campus information',
  studentId: 'Student ID', studentPassword: 'Password', passwordPlaceholder: 'Enter campus password', saved: 'Saved',
  translatingConversation: 'Translating this conversation…', translatedConversation: 'Conversation language switched.', translationNeedKey: 'Add a DeepSeek API key before translating this conversation.', translationFailed: 'Some messages could not be translated and were kept as-is.', back: 'Back', contacting: 'Contacting DeepSeek',
  readingTime: 'Reading phone time', locating: 'Requesting location', composing: 'Preparing reply', assistant: 'Zaichang', user: 'You', typing: 'Preparing…',
  draftPlaceholder: 'Tell me what is on your mind…', titleFallback: 'Untitled chat',
  attachFile: 'Add attachment', removeAttachment: 'Remove attachment', attachmentTooLarge: 'The attachment is too large. Choose a smaller file.', attachmentInvalid: 'This file is not supported. Choose an image or text file.', imageReady: 'Please look at this image', textAttachmentReady: 'Please read this text attachment',
  reminders: 'Reminders', remindersHint: 'Stored on this device and shown on time', remindersTitle: 'Reminders', reminderEmpty: 'No reminders yet', reminderTitle: 'Reminder', reminderNotes: 'Notes (optional)', reminderTime: 'Time', addReminder: 'Add reminder', complete: 'Done', reminderSaved: 'Saved on this device', notificationDenied: 'Saved, but system notifications are disabled.', webReminderNote: 'Browser preview cannot send system notifications; install the APK to receive them.', memoryRemove: 'Remove memory', historySearchPlaceholder: 'Search chat history',
};

export function getUiCopy(language: MobileLanguage): UiCopy {
  if (language === 'zh-TW') return TRADITIONAL;
  if (language === 'en') return ENGLISH;
  return SIMPLIFIED;
}
