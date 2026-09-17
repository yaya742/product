import { spawn, type ChildProcess } from 'node:child_process';
import type { LocationStatusResult, MapOverview, LocationFix } from '../shared/map-v2';
import { classifyFix, abruptFixJump } from '../shared/map-routing';

// Windows' own location service, not a web IP lookup and not a phone location.
// One short-lived request; no coordinates are written to disk or sent to the model.
const script = String.raw`
$ErrorActionPreference='Stop'
$watcher=$null
try {
  Add-Type -AssemblyName System.Device
  $watcher=New-Object System.Device.Location.GeoCoordinateWatcher
  $started=$watcher.TryStart($false,[TimeSpan]::FromSeconds(12))
  if($watcher.Permission -eq 'Denied') { @{status='denied'} | ConvertTo-Json -Compress; exit }
  $deadline=[DateTime]::UtcNow.AddSeconds(3)
  while($watcher.Position.Location.IsUnknown -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  $position=$watcher.Position
  if($position.Location.IsUnknown) { @{status='unavailable'} | ConvertTo-Json -Compress; exit }
  @{status='ok'; longitude=$position.Location.Longitude; latitude=$position.Location.Latitude; accuracy=$position.Location.HorizontalAccuracy; timestamp=$position.Timestamp.ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress
} catch { @{status='unavailable'} | ConvertTo-Json -Compress }
finally { if($watcher){$watcher.Stop();$watcher.Dispose()} }
`;
export class MapLocationProvider {
  private child: ChildProcess | undefined;
  private revision = 0;
  private previousFix: LocationFix | undefined;
  cancel() {
    this.revision++;
    this.child?.kill();
    this.child = undefined;
    this.previousFix = undefined;
  }
  async read(manifest: MapOverview): Promise<LocationStatusResult> {
    const previous = this.previousFix;
    this.cancel();
    const revision = this.revision;
    const result = (
      status: LocationStatusResult['status'],
      reason: string,
      fix?: LocationFix,
    ): LocationStatusResult => ({ status, reason, source: 'windows-native', phoneConnected: false, fix });
    if (process.platform !== 'win32')
      return result('unavailable', '当前平台尚未接入本机位置。请手动选择起点。');
    const response = await new Promise<string>((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.child = child;
      let output = '',
        settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(output);
      };
      child.stdout?.on('data', (b) => {
        if (output.length < 4096) output += b.toString();
      });
      const timer = setTimeout(() => {
        child.kill();
        done();
      }, 18000);
      child.on('error', done);
      child.on('close', done);
    });
    if (revision !== this.revision) return result('idle', '定位已停止。');
    this.child = undefined;
    let r: any;
    try {
      r = JSON.parse(response.trim());
    } catch {
      return result('unavailable', '本机位置暂不可用。请检查 Windows 位置服务，或手动选择起点。');
    }
    if (r.status === 'denied')
      return result('denied', 'Windows 未允许本机定位。可在系统隐私设置中开启，或手动选择起点。');
    if (r.status !== 'ok')
      return result('unavailable', 'Windows 暂时没有提供位置。可检查系统位置服务，或手动选择起点。');
    const fix: LocationFix = {
      coordinate: [r.longitude, r.latitude],
      accuracy: r.accuracy,
      timestamp: r.timestamp,
      crs: 'EPSG:4326',
      source: 'windows-native',
      deviceLabel: '这台 Windows 电脑',
    };
    const status = classifyFix(fix, manifest.bounds, Date.now(), previous);
    if (['fresh', 'approximate', 'outside'].includes(status)) this.previousFix = fix;
    const reason =
      status === 'fresh'
        ? '本机位置已更新。'
        : status === 'approximate'
          ? abruptFixJump(fix, previous)
            ? '位置出现较大跳变，请确认实际起点；未据此生成移动轨迹。'
            : `本机位置精度约 ${Math.round(fix.accuracy)} 米，请确认实际起点。`
          : status === 'outside'
            ? '本机位置在当前覆盖范围外。'
            : status === 'stale'
              ? '系统返回的是过期位置，不能作为当前起点。'
              : '系统位置格式无效，请手动选择起点。';
    return result(status, reason, status === 'unavailable' ? undefined : fix);
  }
}
