import { readCampusInfo } from './campus';
import { installBackgroundWebPolyfills } from './backgroundWebPolyfills';

type RunnerCallback = (value?: unknown) => void;
type RunnerHandler = (resolve: RunnerCallback, reject: RunnerCallback, args: Record<string, unknown>) => void;

declare function addEventListener(eventName: string, handler: RunnerHandler): void;

installBackgroundWebPolyfills();

addEventListener('campusSync', async (resolve, reject, args) => {
  try {
    const studentId = typeof args.studentId === 'string' ? args.studentId : '';
    const password = typeof args.password === 'string' ? args.password : '';
    const academicYear = typeof args.academicYear === 'string' ? args.academicYear : undefined;
    const term = typeof args.term === 'string' ? args.term : undefined;
    const campus = await readCampusInfo(studentId, password, {
      academicYear,
      term,
      backgroundRefresh: true,
    });
    if (!campus.refreshedDomains?.length) throw new Error('no_domains_refreshed');
    resolve(campus);
  } catch {
    // Keep the previous encrypted snapshot on any auth, network, parse or
    // partial-runner failure; do not expose campus credentials in logs.
    reject({ name: 'CampusRefreshError', message: 'campus_refresh_failed' });
  }
});
