import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { UpdateController } from '../src/updater.js';

class MockAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.checked = 0;
    this.installed = false;
  }

  async checkForUpdates() {
    this.checked += 1;
    this.emit('checking-for-update');
    this.emit('update-available', { version: '1.0.1' });
    this.emit('download-progress', { percent: 55.4 });
    this.emit('update-downloaded', { version: '1.0.1' });
  }

  quitAndInstall() {
    this.installed = true;
  }
}

describe('UpdateController - GitHub 실시간 자동 업데이트 흐름', () => {
  it('개발 모드(isPackaged=false)에서는 안전하게 비활성 상태를 유지한다', async () => {
    const updater = new MockAutoUpdater();
    const ctrl = new UpdateController({
      app: { isPackaged: false, getVersion: () => '1.0.0' },
      autoUpdater: updater,
    });
    expect(ctrl.getState().status).toBe('dev-disabled');
    const res = await ctrl.checkNow();
    expect(res.success).toBe(true);
    expect(updater.checked).toBe(0);
  });

  it('설치 모드(isPackaged=true)에서 새 버전 감지 → 다운로드 → 백업 후 재시작 설치가 정상 동작한다', async () => {
    const updater = new MockAutoUpdater();
    const states = [];
    let backedUp = false;

    const ctrl = new UpdateController({
      app: { isPackaged: true, getVersion: () => '1.0.0' },
      autoUpdater: updater,
      onStateChange: (s) => states.push(s.status),
      onBeforeInstall: () => { backedUp = true; },
    });

    await ctrl.checkNow();
    expect(states).toEqual(['checking', 'available', 'downloading', 'downloaded']);
    expect(ctrl.getState().latestVersion).toBe('1.0.1');
    expect(ctrl.getState().percent).toBe(100);

    const installRes = ctrl.installNow();
    expect(installRes.success).toBe(true);
    expect(backedUp).toBe(true);

    await new Promise((r) => setImmediate(r));
    expect(updater.installed).toBe(true);
  });
});
