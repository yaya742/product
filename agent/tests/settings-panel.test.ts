import assert from 'node:assert/strict';
import test from 'node:test';
import { campusAccountFeedback } from '../src/renderer/campus-account-feedback';

test('campus account feedback does not claim success when the connector is not configured', () => {
  const feedback = campusAccountFeedback({ campusConnector: null });
  assert.equal(feedback.action, 'account-connect');
  assert.equal(feedback.error, undefined);
  assert.match(feedback.text, /登录未完成/);
  assert.doesNotMatch(feedback.text, /已登录|已验证/);
});

test('campus account feedback reports verified state only after backend verification', () => {
  const feedback = campusAccountFeedback({
    campusConnector: {
      configured: true,
      available: true,
      label: '浙大校园账号',
      authStatus: 'verified',
      credentialsConfigured: true,
    },
  });
  assert.equal(feedback.error, undefined);
  assert.equal(feedback.text, '浙大账号已验证，可以按需读取校园资料');
});

test('campus account feedback exposes a saved-but-unverified state', () => {
  const feedback = campusAccountFeedback({
    campusConnector: {
      configured: true,
      available: true,
      label: '浙大校园账号',
      authStatus: 'credentials_saved',
      credentialsConfigured: true,
    },
  });
  assert.equal(feedback.error, true);
  assert.match(feedback.text, /尚未验证/);
});

test('campus account feedback exposes the latest safe verification failure', () => {
  const feedback = campusAccountFeedback({
    campusConnector: {
      configured: true,
      available: true,
      label: '浙大校园账号',
      authStatus: 'failed',
      credentialsConfigured: true,
      reason: '统一身份认证要求额外验证码，请先在浏览器完成安全校验。',
    },
  });
  assert.equal(feedback.error, true);
  assert.equal(feedback.text, '统一身份认证要求额外验证码，请先在浏览器完成安全校验。');
});
