import type { State } from '../shared/types';

export interface CampusAccountFeedback {
  action: 'account-connect';
  text: string;
  error?: boolean;
}

export function campusAccountFeedback(next: Pick<State, 'campusConnector'>): CampusAccountFeedback {
  const connector = next.campusConnector;
  if (connector?.configured && connector.available && connector.authStatus === 'verified')
    return { action: 'account-connect', text: '浙大账号已验证，可以按需读取校园资料' };
  if (!connector?.configured)
    return { action: 'account-connect', text: '登录未完成：没有选择浙大连接器，当前不会读取校园资料' };
  if (!connector.available)
    return {
      action: 'account-connect',
      text: `登录未完成：${connector.reason || '浙大校园连接器暂时不可用'}`,
      error: true,
    };
  if (connector.credentialsConfigured === false)
    return { action: 'account-connect', text: '登录未完成：尚未保存浙大登录信息', error: true };
  return {
    action: 'account-connect',
    text: connector.reason || '登录未完成：浙大账号尚未验证',
    error: true,
  };
}
