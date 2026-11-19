'use strict';

const path = require('node:path');
const { LocalDatabase } = require('./db');
const { SmsService } = require('./sms');
const { TherapyAppService } = require('./business');
const { LocalHttpServer } = require('./server');

async function startCli() {
  const dataDir = process.env.THERAPY_DATA_DIR || path.join(__dirname, '..', '.local-data');
  const dbPath = path.join(dataDir, 'therapy-charting.sqlite');
  const backupDir = path.join(dataDir, 'backups');
  const port = Number(process.env.PORT || 3840);

  const db = new LocalDatabase(dbPath, { backupDir });
  const sms = new SmsService(db);
  let httpServer = null;

  const service = new TherapyAppService(db, sms, {
    getRuntimeInfo: () => ({
      ...(httpServer ? httpServer.getRuntimeInfo() : {}),
      앱버전: '1.0.0',
      데스크톱앱: false,
    }),
    onConfigChanged: async (changes) => {
      if (changes && typeof changes.lanEnabled === 'boolean' && httpServer) {
        await httpServer.reconfigure({ lanEnabled: changes.lanEnabled });
      }
    },
  });

  const lanEnabled = db.getProperty('LAN_SHARE_ENABLED', 'N') === 'Y';
  httpServer = new LocalHttpServer(service, db, {
    publicDir: path.join(__dirname, '..', 'public'),
    port,
    lanEnabled,
  });
  const boundPort = await httpServer.start();
  console.log(`[원탑통증재활센터 로컬 서버] http://127.0.0.1:${boundPort}`);
  console.log(`[데이터 파일] ${dbPath}`);
}

startCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
