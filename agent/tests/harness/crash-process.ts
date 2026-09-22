import { Store } from '../../src/main/store';
const file = process.argv[2];
const store = new Store(file);
store.kernel.fault = (point) => {
  if (point === 'after_event_and_outbox_commit') process.exit(74);
};
store.runtime.begin(
  '进程中断前的合成输入已接收。' +
    (process.argv.includes('--attachment')
      ? '\n\n[用户附上的文字资料：附件.md]\n附件尾部 CRASH_ATTACHMENT_TAIL'
      : ''),
  'crash-ingress',
  'crash-conversation',
  new AbortController().signal,
);
throw new Error('Crash injection did not fire');
