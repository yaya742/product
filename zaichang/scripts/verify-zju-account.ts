import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/main/store';
import { ToolRegistry } from '../src/main/tools';
import { ZjuAdapter, CAMPUS_ACCOUNT_SOURCE_ID } from '../src/main/zjuAdapter';

if (process.env.ZAICHANG_ALLOW_ZJU_SMOKE !== '1')
  throw new Error('Set ZAICHANG_ALLOW_ZJU_SMOKE=1 for an explicitly authorized, read-only account check.');

const output = path.resolve(
  process.env.ZAICHANG_ZJU_SMOKE_REPORT || 'artifacts/zju-account/integration-smoke.json',
);
fs.mkdirSync(path.dirname(output), { recursive: true });

const store = new Store(':memory:');
const adapter = new ZjuAdapter(store);
const signal = AbortSignal.timeout(180_000);

function unsafeKeys(value: unknown, at = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => unsafeKeys(item, `${at}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const unsafe =
      /^(?:password|passwd|secret|token|ticket|cookie|authorization|body_b64|student.?no|student.?id|card.?no|card_number|identity.?no|identity.?id|phone|mobile|email|account|sno|xh|yhm|xm|zgh|custid|custmemberid|acctid|cardid|bankacc|cert)$/i.test(
        key,
      );
    return [...(unsafe ? [`${at}.${key}`] : []), ...unsafeKeys(item, `${at}.${key}`)];
  });
}

try {
  const before = adapter.describe();
  const authentication = await adapter.verifyAccount(signal);
  if (authentication.status !== 'ok')
    throw new Error(authentication.error?.message || authentication.reason || 'ZJU SSO verification failed.');

  const registry = new ToolRegistry({
    store,
    signal,
    userText: '请整理我的全部浙大校园个人信息，并说明哪些会影响眼前安排。',
    currentUserId: 'zju-account-smoke',
    child: false,
    campus: adapter,
    step: () => {},
    plan: () => {},
    action: () => {},
    changed: () => {},
    delegate: async () => [],
  });
  const raw = JSON.parse(
    await registry.execute(
      'look_up',
      JSON.stringify({ source: 'campus', mode: 'overview', includeSensitiveDomains: true }),
    ),
  );
  const serialized = JSON.stringify(raw);
  const domains = Array.isArray(raw.data?.domains) ? raw.data.domains : [];
  const ownedCourseId = domains
    .find((domain: any) => domain.domain === 'learning_courses')
    ?.records?.find((record: any) => typeof record?.id === 'number' || /^\d+$/.test(String(record?.id || '')))?.id;
  const activityRaw = ownedCourseId
    ? JSON.parse(
        await registry.execute(
          'look_up',
          JSON.stringify({
            source: 'campus',
            mode: 'detail',
            domain: 'activities',
            courseId: String(ownedCourseId),
            limit: 4,
          }),
        ),
      )
    : undefined;
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    operation: 'read_only_zju_account_overview',
    connector: {
      autoDiscovered: before.configured && before.sourceKind === 'zju_account',
      available: before.available,
      credentialsPresent: before.credentialsConfigured === true,
      authStatusAfter: adapter.describe().authStatus,
      lastVerifiedAt: adapter.describe().lastVerifiedAt,
    },
    authentication: {
      status: authentication.status,
      sso: authentication.sso === true,
      businessDataReadDuringAuth: authentication.student_data_fetched === true,
    },
    modelToolBoundary: {
      sourceId: raw.sourceId,
      expectedSourceId: CAMPUS_ACCOUNT_SOURCE_ID,
      origin: raw.data?.origin,
      authenticated: raw.data?.authenticated,
      status: raw.status,
      serializedBytes: Buffer.byteLength(serialized),
      unsafeKeyCount: unsafeKeys(raw).length,
      bearerOrJwtPresent: /Bearer\s+[A-Za-z0-9_.-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(serialized),
      ownedCourseActivity: activityRaw
        ? {
            status: activityRaw.status,
            sourceId: activityRaw.sourceId,
            origin: activityRaw.data?.origin,
            returnedRecords: Array.isArray(activityRaw.data?.records) ? activityRaw.data.records.length : 0,
            fieldNames: [
              ...new Set(
                (Array.isArray(activityRaw.data?.records) ? activityRaw.data.records : []).flatMap(
                  (record: any) => (record && typeof record === 'object' ? Object.keys(record) : []),
                ),
              ),
            ].sort(),
            unsafeKeyCount: unsafeKeys(activityRaw).length,
          }
        : { status: 'not_run_no_owned_course_id_in_bounded_overview' },
    },
    coverage: {
      requestedSensitiveDomains: true,
      returnedDomainCount: domains.length,
      missingDomains: raw.data?.missingDomains || [],
      incompleteDomains: raw.data?.incompleteDomains || [],
      domains: domains.map((domain: any) => ({
        domain: domain.domain,
        status: domain.status,
        total: domain.total,
        returnedRecords: Array.isArray(domain.records) ? domain.records.length : 0,
        fieldNames: [
          ...new Set(
            (Array.isArray(domain.records) ? domain.records : []).flatMap((record: any) =>
              record && typeof record === 'object' ? Object.keys(record) : [],
            ),
          ),
        ].sort(),
        fetchedAt: domain.fetchedAt,
        complete: domain.complete,
        issues: domain.issues || [],
      })),
    },
    assertions: {
      realAccountSource: raw.sourceId === CAMPUS_ACCOUNT_SOURCE_ID && raw.data?.origin === 'zju_account',
      ssoVerified: authentication.status === 'ok' && authentication.sso === true,
      credentialsExcluded: unsafeKeys(raw).length === 0 && !/Bearer\s+|\beyJ[A-Za-z0-9_-]+\./.test(serialized),
      noLegacyImportFallback: raw.data?.source === '浙江大学本人账号',
      ownedCourseActivityPath:
        !ownedCourseId ||
        (activityRaw?.sourceId === CAMPUS_ACCOUNT_SOURCE_ID &&
          activityRaw?.data?.origin === 'zju_account' &&
          unsafeKeys(activityRaw).length === 0),
    },
    limitations: [
      'The report stores counts, statuses and field names only; personal field values are deliberately omitted.',
      'Cached encrypted account snapshots can answer ordinary questions; only explicit refresh requests contact business systems again.',
      'Course activity detail is fetched one owned course at a time after resolving its course id.',
    ],
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(
    JSON.stringify({
      status: Object.values(report.assertions).every(Boolean) ? 'passed' : 'failed',
      report: output,
      domains: domains.length,
      toolStatus: raw.status,
    }),
  );
  if (!Object.values(report.assertions).every(Boolean)) process.exitCode = 1;
} finally {
  store.close();
}
