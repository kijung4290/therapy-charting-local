'use strict';

const { kstTimestamp } = require('./utils');

class UpdateController {
  constructor(options = {}) {
    this.app = options.app;
    this.autoUpdater = options.autoUpdater || null;
    this.onStateChange = options.onStateChange || (() => {});
    this.onBeforeInstall = options.onBeforeInstall || (() => {});
    this.pollIntervalMs = options.pollIntervalMs || 30 * 60 * 1000;
    this.initialDelayMs = options.initialDelayMs || 15 * 1000;
    this._timer = null;
    this._initTimer = null;
    this._checking = false;

    const currentVersion = this.app ? this.app.getVersion() : '1.0.0';
    this.state = {
      status: this.isEnabled() ? 'idle' : 'dev-disabled',
      currentVersion,
      latestVersion: currentVersion,
      percent: 0,
      message: this.isEnabled()
        ? '실시간 자동 업데이트 대기 중 (30분마다 자동 확인)'
        : '개발 실행 모드에서는 자동 업데이트가 비활성화됩니다 (설치 버전에서 자동 작동)',
      lastCheckedAt: '',
    };

    if (this.isEnabled() && this.autoUpdater) {
      this._wireEvents();
    }
  }

  isEnabled() {
    return !!(this.app && this.app.isPackaged && this.autoUpdater);
  }

  getState() {
    return { ...this.state };
  }

  _updateState(patch) {
    this.state = { ...this.state, ...patch };
    try {
      this.onStateChange(this.getState());
    } catch (_) {}
  }

  _wireEvents() {
    const u = this.autoUpdater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.allowPrerelease = false;

    u.on('checking-for-update', () => {
      this._checking = true;
      this._updateState({
        status: 'checking',
        message: 'GitHub에서 최신 버전을 확인하는 중...',
        lastCheckedAt: kstTimestamp(),
      });
    });

    u.on('update-available', (info) => {
      const ver = (info && info.version) || '';
      this._updateState({
        status: 'available',
        latestVersion: ver || this.state.currentVersion,
        percent: 0,
        message: `새 버전(v${ver})을 발견했습니다. 백그라운드에서 다운로드합니다...`,
      });
    });

    u.on('update-not-available', (info) => {
      this._checking = false;
      const ver = (info && info.version) || this.state.currentVersion;
      this._updateState({
        status: 'not-available',
        latestVersion: ver,
        percent: 0,
        message: `현재 최신 버전(v${this.state.currentVersion})을 사용 중입니다.`,
        lastCheckedAt: kstTimestamp(),
      });
    });

    u.on('download-progress', (progress) => {
      const pct = Math.max(0, Math.min(100, Math.round((progress && progress.percent) || 0)));
      this._updateState({
        status: 'downloading',
        percent: pct,
        message: `새 버전(v${this.state.latestVersion}) 다운로드 중... (${pct}%)`,
      });
    });

    u.on('update-downloaded', (info) => {
      this._checking = false;
      const ver = (info && info.version) || this.state.latestVersion;
      this._updateState({
        status: 'downloaded',
        latestVersion: ver,
        percent: 100,
        message: `새 버전(v${ver}) 다운로드 완료! 재시작하면 바로 적용됩니다.`,
        lastCheckedAt: kstTimestamp(),
      });
    });

    u.on('error', (err) => {
      this._checking = false;
      const msg = String((err && err.message) || err || '업데이트 확인 오류').split('\n')[0].slice(0, 180);
      this._updateState({
        status: 'error',
        message: '업데이트 확인 실패: ' + msg,
        lastCheckedAt: kstTimestamp(),
      });
    });
  }

  start() {
    if (!this.isEnabled()) return;
    this._initTimer = setTimeout(() => {
      this.checkNow({ silent: true });
    }, this.initialDelayMs);
    this._timer = setInterval(() => {
      this.checkNow({ silent: true });
    }, this.pollIntervalMs);
  }

  stop() {
    if (this._initTimer) {
      clearTimeout(this._initTimer);
      this._initTimer = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async checkNow(options = {}) {
    if (!this.isEnabled()) {
      return {
        success: true,
        data: this.getState(),
        message: this.state.message,
      };
    }
    if (this.state.status === 'downloaded') {
      return {
        success: true,
        data: this.getState(),
        message: this.state.message,
      };
    }
    if (this._checking) {
      return {
        success: true,
        data: this.getState(),
        message: '이미 최신 버전을 확인하고 있습니다.',
      };
    }
    try {
      this._checking = true;
      await this.autoUpdater.checkForUpdates();
      return { success: true, data: this.getState(), message: this.state.message };
    } catch (err) {
      this._checking = false;
      if (!options.silent) {
        const msg = String((err && err.message) || err || '업데이트 확인 오류').split('\n')[0].slice(0, 180);
        this._updateState({
          status: 'error',
          message: '업데이트 확인 실패: ' + msg,
          lastCheckedAt: kstTimestamp(),
        });
      }
      return { success: false, message: this.state.message, data: this.getState() };
    }
  }

  installNow() {
    if (!this.isEnabled() || this.state.status !== 'downloaded') {
      return { success: false, message: '설치 대기 중인 업데이트가 없습니다.' };
    }
    try {
      this.onBeforeInstall();
    } catch (_) {}
    setImmediate(() => {
      this.autoUpdater.quitAndInstall(false, true);
    });
    return { success: true, message: '안전 백업 후 업데이트를 설치하고 프로그램을 재시작합니다...' };
  }
}

module.exports = { UpdateController };
