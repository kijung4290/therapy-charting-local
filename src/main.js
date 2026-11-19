'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { LocalDatabase } = require('./db');
const { SmsService } = require('./sms');
const { TherapyAppService } = require('./business');
const { LocalHttpServer } = require('./server');
const { UpdateController } = require('./updater');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let autoSmsTimer = null;
let db = null;
let sms = null;
let service = null;
let httpServer = null;
let updateController = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function getIconPath(ext) {
  const candidate = path.join(__dirname, '..', 'assets', `icon.${ext}`);
  return fs.existsSync(candidate) ? candidate : null;
}

function loadTrayIcon() {
  const pngPath = getIconPath('png') || getIconPath('ico');
  if (pngPath) {
    const img = nativeImage.createFromPath(pngPath);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function applyAutoStartSetting(enabled, startHidden) {
  if (!app.isPackaged) return false;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: enabled && startHidden !== false ? ['--autostart'] : [],
    });
    return true;
  } catch (err) {
    console.error('[부팅 자동 실행 설정 오류]', err);
    return false;
  }
}

function broadcastUpdateState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('local:update-status', state);
    } catch (_) {}
  }
}

function updateTrayMenu() {
  if (!tray || !db) return;
  const autoEnabled = db.getProperty('AUTO_SMS_ENABLED', 'N') === 'Y';
  const lanEnabled = db.getProperty('LAN_SHARE_ENABLED', 'N') === 'Y';
  const autoStartEnabled = db.getProperty('AUTO_START_ENABLED', 'N') === 'Y';
  const autoStartHidden = db.getProperty('AUTO_START_HIDDEN', 'Y') !== 'N';
  const info = httpServer ? httpServer.getRuntimeInfo() : {};
  const uState = updateController ? updateController.getState() : { status: 'idle', currentVersion: app.getVersion() };

  const updateItem =
    uState.status === 'downloaded'
      ? {
          label: `새 버전(v${uState.latestVersion}) 설치 및 재시작`,
          click: () => updateController && updateController.installNow(),
        }
      : {
          label:
            uState.status === 'downloading'
              ? `업데이트 다운로드 중 (${uState.percent}%)`
              : `업데이트 확인 (현재 v${uState.currentVersion})`,
          enabled: uState.status !== 'downloading',
          click: () => {
            showMainWindow();
            if (updateController) updateController.checkNow({ silent: false });
          },
        };

  const menu = Menu.buildFromTemplate([
    {
      label: '원탑통증재활센터 열기',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: `자동문자: ${autoEnabled ? '실행 중 (1분 주기)' : '중지됨'}`,
      enabled: false,
    },
    {
      label: `원내 공유: ${lanEnabled ? `켜짐 (${(info.원내접속주소목록 || [])[0] || info.로컬주소 || ''})` : '꺼짐 (내 PC 전용)'}`,
      enabled: false,
    },
    {
      label: 'PC 부팅 시 자동 실행',
      type: 'checkbox',
      checked: autoStartEnabled,
      click: (menuItem) => {
        const next = !!menuItem.checked;
        db.setProperty('AUTO_START_ENABLED', next ? 'Y' : 'N');
        applyAutoStartSetting(next, autoStartHidden);
        updateTrayMenu();
      },
    },
    updateItem,
    { type: 'separator' },
    {
      label: '데이터 폴더 열기',
      click: () => shell.openPath(app.getPath('userData')),
    },
    {
      label: '백업 폴더 열기',
      click: () => {
        const dir = db.backupDir || app.getPath('userData');
        fs.mkdirSync(dir, { recursive: true });
        shell.openPath(dir);
      },
    },
    { type: 'separator' },
    {
      label: '완전 종료',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip(`원탑통증재활센터 v${app.getVersion()}${autoEnabled ? ' · 자동문자 실행 중' : ''}`);
  tray.setContextMenu(menu);
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const iconPath = getIconPath('ico') || getIconPath('png');
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: '원탑통증재활센터',
    icon: iconPath || undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('local:window-shown');
      } catch (_) {}
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (updateController) {
      broadcastUpdateState(updateController.getState());
    }
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    const trayOnClose = db ? db.getProperty('TRAY_ON_CLOSE', 'Y') !== 'N' : true;
    if (trayOnClose && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(`http://127.0.0.1:${httpServer.port}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${httpServer.port}/`);
}

function setupTray() {
  tray = new Tray(loadTrayIcon());
  tray.on('double-click', () => showMainWindow());
  updateTrayMenu();
}

function startAutoSmsScheduler() {
  const tick = () => {
    if (!sms) return;
    sms.runAutoSms().catch((err) => {
      console.error('[자동문자 실행 오류]', err);
    });
  };
  setTimeout(tick, 10000);
  autoSmsTimer = setInterval(tick, 60 * 1000);
}

app.on('second-instance', () => {
  showMainWindow();
});

app.whenReady().then(async () => {
  try {
    const userDataDir = app.getPath('userData');
    const dbPath = path.join(userDataDir, 'therapy-charting.sqlite');
    const backupDir = path.join(userDataDir, 'backups');

    db = new LocalDatabase(dbPath, { backupDir });
    sms = new SmsService(db);

    const lanEnabled = db.getProperty('LAN_SHARE_ENABLED', 'N') === 'Y';
    const autoStartEnabled = db.getProperty('AUTO_START_ENABLED', 'N') === 'Y';
    const autoStartHidden = db.getProperty('AUTO_START_HIDDEN', 'Y') !== 'N';
    if (autoStartEnabled) {
      applyAutoStartSetting(true, autoStartHidden);
    }

    service = new TherapyAppService(db, sms, {
      getRuntimeInfo: () => ({
        ...(httpServer ? httpServer.getRuntimeInfo() : {}),
        앱버전: app.getVersion(),
        데스크톱앱: true,
        패키지실행: app.isPackaged,
      }),
      onConfigChanged: async (changes) => {
        if (changes && typeof changes.lanEnabled === 'boolean' && httpServer) {
          try {
            await httpServer.reconfigure({ lanEnabled: changes.lanEnabled });
          } catch (err) {
            console.error('[서버 재바인딩 실패]', err);
          }
        }
        if (changes && typeof changes.autoStartEnabled === 'boolean') {
          applyAutoStartSetting(changes.autoStartEnabled, changes.autoStartHidden !== false);
        }
        updateTrayMenu();
      },
    });

    httpServer = new LocalHttpServer(service, db, {
      publicDir: path.join(__dirname, '..', 'public'),
      port: 3840,
      lanEnabled,
    });
    await httpServer.start();

    updateController = new UpdateController({
      app,
      autoUpdater,
      onStateChange: (state) => {
        broadcastUpdateState(state);
        updateTrayMenu();
      },
      onBeforeInstall: () => {
        isQuitting = true;
        if (db) {
          try { db.createBackup('before_update'); } catch (_) {}
        }
      },
    });

    ipcMain.handle('local:open-data-folder', () => shell.openPath(userDataDir));
    ipcMain.handle('local:open-backup-folder', () => {
      fs.mkdirSync(backupDir, { recursive: true });
      return shell.openPath(backupDir);
    });
    ipcMain.handle('local:get-version', () => app.getVersion());
    ipcMain.handle('local:get-update-status', () => updateController.getState());
    ipcMain.handle('local:check-updates', () => updateController.checkNow({ silent: false }));
    ipcMain.handle('local:install-update', () => updateController.installNow());

    setupTray();
    const launchedByAutoStart = process.argv.includes('--autostart');
    const trayOnClose = db.getProperty('TRAY_ON_CLOSE', 'Y') !== 'N';
    if (!(launchedByAutoStart && autoStartHidden && trayOnClose)) {
      createWindow();
    }
    startAutoSmsScheduler();
    updateController.start();
  } catch (err) {
    dialog.showErrorBox('프로그램 시작 오류', '로컬 앱 초기화 중 오류가 발생했습니다:\n' + err.message);
    isQuitting = true;
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (isQuitting || process.platform !== 'darwin') {
    const trayOnClose = db ? db.getProperty('TRAY_ON_CLOSE', 'Y') !== 'N' : false;
    if (!trayOnClose || isQuitting) {
      app.quit();
    }
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  if (updateController) {
    try { updateController.stop(); } catch (_) {}
  }
  if (autoSmsTimer) {
    clearInterval(autoSmsTimer);
    autoSmsTimer = null;
  }
  if (httpServer) {
    try { await httpServer.stop(); } catch (_) {}
  }
  if (db) {
    try { db.close(); } catch (_) {}
  }
});
