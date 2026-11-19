'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  APP_CONFIG,
  kstTimestamp,
  normalizeCheckStorage,
  deserializeCheckValue,
} = require('./utils');

function str(val) {
  return val == null ? '' : String(val);
}

class LocalDatabase {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.isMemory = dbPath === ':memory:';
    this.backupDir = options.backupDir || (this.isMemory ? null : path.join(path.dirname(dbPath), 'backups'));
    if (!this.isMemory) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      if (this.backupDir) fs.mkdirSync(this.backupDir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this._txDepth = 0;
    this.initSchema();
  }

  initSchema() {
    if (!this.isMemory) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA busy_timeout = 10000;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        _seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        registered_at TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        birth_date TEXT NOT NULL DEFAULT '',
        gender TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        memo TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);

      CREATE TABLE IF NOT EXISTS therapists (
        _seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        registered_at TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        memo TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_therapists_name ON therapists(name);

      CREATE TABLE IF NOT EXISTS services (
        _seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        registered_at TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        price TEXT NOT NULL DEFAULT '',
        duration TEXT NOT NULL DEFAULT '',
        memo TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS schedules (
        _seq INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL UNIQUE,
        date TEXT NOT NULL DEFAULT '',
        start_time TEXT NOT NULL DEFAULT '',
        end_time TEXT NOT NULL DEFAULT '',
        therapist TEXT NOT NULL DEFAULT '',
        client TEXT NOT NULL DEFAULT '',
        service TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '예약',
        memo TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL DEFAULT '',
        visit_checked TEXT NOT NULL DEFAULT '',
        care_checked TEXT NOT NULL DEFAULT '',
        payment_checked TEXT NOT NULL DEFAULT '',
        reminder_sms_sent TEXT NOT NULL DEFAULT '',
        admin_sms_sent TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules(date);
      CREATE INDEX IF NOT EXISTS idx_schedules_client ON schedules(client);
      CREATE INDEX IF NOT EXISTS idx_schedules_therapist ON schedules(therapist);

      CREATE TABLE IF NOT EXISTS charts (
        _seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chart_id TEXT NOT NULL UNIQUE,
        schedule_id TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL DEFAULT '',
        therapist TEXT NOT NULL DEFAULT '',
        client TEXT NOT NULL DEFAULT '',
        service TEXT NOT NULL DEFAULT '',
        treatment_content TEXT NOT NULL DEFAULT '',
        evaluation TEXT NOT NULL DEFAULT '',
        desk_note TEXT NOT NULL DEFAULT '',
        director_note TEXT NOT NULL DEFAULT '',
        client_response TEXT NOT NULL DEFAULT '',
        next_plan TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_charts_schedule_id ON charts(schedule_id);
      CREATE INDEX IF NOT EXISTS idx_charts_client ON charts(client);

      CREATE TABLE IF NOT EXISTS sms_logs (
        _seq INTEGER PRIMARY KEY AUTOINCREMENT,
        sent_at TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        client TEXT NOT NULL DEFAULT '',
        recipient_phone TEXT NOT NULL DEFAULT '',
        message_content TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL DEFAULT '',
        result_code TEXT NOT NULL DEFAULT '',
        result_message TEXT NOT NULL DEFAULT '',
        test_mode TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_sms_logs_sent_at ON sms_logs(sent_at);

      CREATE TABLE IF NOT EXISTS settings (
        _seq INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS therapist_offs (
        _seq INTEGER PRIMARY KEY AUTOINCREMENT,
        off_id TEXT NOT NULL UNIQUE,
        date TEXT NOT NULL DEFAULT '',
        therapist TEXT NOT NULL DEFAULT '',
        start_time TEXT NOT NULL DEFAULT '',
        end_time TEXT NOT NULL DEFAULT '',
        memo TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_offs_date ON therapist_offs(date);
      CREATE INDEX IF NOT EXISTS idx_offs_therapist ON therapist_offs(therapist);

      CREATE TABLE IF NOT EXISTS app_properties (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);

    this.ensureDefaultPasswords();
  }

  ensureDefaultPasswords() {
    const adminPw = this.getSetting('관리자비밀번호', null);
    if (adminPw == null || adminPw === '') {
      this.setSetting('관리자비밀번호', APP_CONFIG.관리자비밀번호);
    }
    const mainPw = this.getSetting('메인접속비밀번호', null);
    if (mainPw == null || mainPw === '') {
      const effectiveAdmin = this.getSetting('관리자비밀번호', APP_CONFIG.메인접속비밀번호);
      this.setSetting('메인접속비밀번호', effectiveAdmin || APP_CONFIG.메인접속비밀번호);
    }
  }

  transaction(fn) {
    if (this._txDepth > 0) {
      return fn();
    }
    this._txDepth += 1;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (_) {}
      throw err;
    } finally {
      this._txDepth -= 1;
    }
  }

  close() {
    this.db.close();
  }

  createBackup(reason = 'manual') {
    if (this.isMemory || !this.backupDir) return null;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const now = new Date();
    const stamp = kstTimestamp(now).replace(/[-:]/g, '').replace(' ', '_') + '_' + String(now.getMilliseconds()).padStart(3, '0');
    const safeReason = String(reason || 'backup').replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
    let fileName = `치료차팅_백업_${stamp}_${safeReason}.sqlite`;
    let targetPath = path.join(this.backupDir, fileName);
    let seq = 1;
    while (fs.existsSync(targetPath)) {
      fileName = `치료차팅_백업_${stamp}_${safeReason}_${seq}.sqlite`;
      targetPath = path.join(this.backupDir, fileName);
      seq += 1;
    }
    const escaped = targetPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}';`);
    return { fileName, filePath: targetPath };
  }

  listBackups() {
    if (this.isMemory || !this.backupDir || !fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.sqlite'))
      .map((f) => {
        const full = path.join(this.backupDir, f);
        const stat = fs.statSync(full);
        return {
          파일명: f,
          경로: full,
          크기: stat.size,
          생성일시: kstTimestamp(stat.mtime),
        };
      })
      .sort((a, b) => b.생성일시.localeCompare(a.생성일시))
      .slice(0, 30);
  }

  // === app_properties (replaces PropertiesService.getScriptProperties()) ===
  getProperty(key, defaultValue = null) {
    const row = this.db.prepare('SELECT value FROM app_properties WHERE key = ?').get(String(key));
    return row ? row.value : defaultValue;
  }

  getAllProperties() {
    const rows = this.db.prepare('SELECT key, value FROM app_properties').all();
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  setProperty(key, value) {
    this.db.prepare(`
      INSERT INTO app_properties (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), str(value));
  }

  setProperties(obj) {
    this.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO app_properties (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      for (const [k, v] of Object.entries(obj || {})) {
        stmt.run(String(k), str(v));
      }
    });
  }

  deleteProperty(key) {
    this.db.prepare('DELETE FROM app_properties WHERE key = ?').run(String(key));
  }

  // === 설정 시트 ===
  getSetting(key, defaultValue = '') {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
    if (row && row.value !== '' && row.value != null) return String(row.value);
    return defaultValue;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key).trim(), str(value));
  }

  getAllSettings() {
    return this.db.prepare('SELECT key, value FROM settings ORDER BY _seq ASC').all().map((r) => ({
      키: r.key,
      값: r.value,
    }));
  }

  // === Row mappers ===
  static mapClient(r) {
    if (!r) return null;
    return {
      ID: r.id,
      등록일시: r.registered_at,
      이름: r.name,
      생년월일: r.birth_date,
      성별: r.gender,
      연락처: r.phone,
      주소: r.address,
      특이사항: r.notes,
      비고: r.memo,
    };
  }

  static mapTherapist(r) {
    if (!r) return null;
    return {
      ID: r.id,
      등록일시: r.registered_at,
      이름: r.name,
      직책: r.title,
      연락처: r.phone,
      비고: r.memo,
    };
  }

  static mapService(r) {
    if (!r) return null;
    const priceNum = Number(r.price);
    const durNum = Number(r.duration);
    return {
      ID: r.id,
      등록일시: r.registered_at,
      서비스명: r.name,
      '금액(원)': r.price !== '' && !Number.isNaN(priceNum) ? priceNum : r.price,
      '소요시간(분)': r.duration !== '' && !Number.isNaN(durNum) ? durNum : r.duration,
      비고: r.memo,
    };
  }

  static mapSchedule(r) {
    if (!r) return null;
    return {
      일정ID: r.schedule_id,
      날짜: r.date,
      시작시간: r.start_time,
      종료시간: r.end_time,
      치료사: r.therapist,
      고객: r.client,
      서비스: r.service,
      상태: r.status,
      비고: r.memo,
      등록일시: r.registered_at,
      방문확인: deserializeCheckValue(r.visit_checked),
      관리확인: deserializeCheckValue(r.care_checked),
      수납확인: deserializeCheckValue(r.payment_checked),
      '예약문자 발송확인': deserializeCheckValue(r.reminder_sms_sent),
      '관리자문자 발송확인': deserializeCheckValue(r.admin_sms_sent),
    };
  }

  static mapChart(r) {
    if (!r) return null;
    const out = {
      차팅ID: r.chart_id,
      일정ID: r.schedule_id,
      날짜: r.date,
      치료사: r.therapist,
      고객: r.client,
      서비스: r.service,
      '관리(시술)내용': r.treatment_content,
      결과평가: r.evaluation,
      데스크기재: r.desk_note,
      대표님기재: r.director_note,
      작성일시: r.created_at,
    };
    if (r.client_response) out.고객반응 = r.client_response;
    if (r.next_plan) out.다음시술계획 = r.next_plan;
    return out;
  }

  static mapSmsLog(r) {
    if (!r) return null;
    return {
      발송일시: r.sent_at,
      구분: r.category,
      고객: r.client,
      수신번호: r.recipient_phone,
      메시지내용: r.message_content,
      메시지ID: r.message_id,
      문자유형: r.message_type,
      결과코드: r.result_code,
      결과메시지: r.result_message,
      테스트모드: r.test_mode,
    };
  }

  static mapOff(r) {
    if (!r) return null;
    return {
      오프ID: r.off_id,
      날짜: r.date,
      치료사: r.therapist,
      시작시간: r.start_time,
      종료시간: r.end_time,
      비고: r.memo,
      등록일시: r.registered_at,
    };
  }

  // === Clients ===
  getAllClients() {
    return this.db.prepare('SELECT * FROM clients ORDER BY _seq ASC').all().map(LocalDatabase.mapClient);
  }

  getClientById(id) {
    return LocalDatabase.mapClient(this.db.prepare('SELECT * FROM clients WHERE id = ?').get(str(id)));
  }

  upsertClient(row) {
    this.db.prepare(`
      INSERT INTO clients (id, registered_at, name, birth_date, gender, phone, address, notes, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        registered_at = excluded.registered_at,
        name = excluded.name,
        birth_date = excluded.birth_date,
        gender = excluded.gender,
        phone = excluded.phone,
        address = excluded.address,
        notes = excluded.notes,
        memo = excluded.memo
    `).run(
      str(row.ID),
      str(row.등록일시),
      str(row.이름),
      str(row.생년월일),
      str(row.성별),
      str(row.연락처),
      str(row.주소),
      str(row.특이사항),
      str(row.비고),
    );
    return this.getClientById(row.ID);
  }

  deleteClient(id) {
    return this.db.prepare('DELETE FROM clients WHERE id = ?').run(str(id)).changes > 0;
  }

  // === Therapists ===
  getAllTherapists() {
    return this.db.prepare('SELECT * FROM therapists ORDER BY _seq ASC').all().map(LocalDatabase.mapTherapist);
  }

  getTherapistById(id) {
    return LocalDatabase.mapTherapist(this.db.prepare('SELECT * FROM therapists WHERE id = ?').get(str(id)));
  }

  upsertTherapist(row) {
    this.db.prepare(`
      INSERT INTO therapists (id, registered_at, name, title, phone, memo)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        registered_at = excluded.registered_at,
        name = excluded.name,
        title = excluded.title,
        phone = excluded.phone,
        memo = excluded.memo
    `).run(
      str(row.ID),
      str(row.등록일시),
      str(row.이름),
      str(row.직책),
      str(row.연락처),
      str(row.비고),
    );
    return this.getTherapistById(row.ID);
  }

  deleteTherapist(id) {
    return this.db.prepare('DELETE FROM therapists WHERE id = ?').run(str(id)).changes > 0;
  }

  // === Services ===
  getAllServices() {
    return this.db.prepare('SELECT * FROM services ORDER BY _seq ASC').all().map(LocalDatabase.mapService);
  }

  getServiceById(id) {
    return LocalDatabase.mapService(this.db.prepare('SELECT * FROM services WHERE id = ?').get(str(id)));
  }

  upsertService(row) {
    this.db.prepare(`
      INSERT INTO services (id, registered_at, name, price, duration, memo)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        registered_at = excluded.registered_at,
        name = excluded.name,
        price = excluded.price,
        duration = excluded.duration,
        memo = excluded.memo
    `).run(
      str(row.ID),
      str(row.등록일시),
      str(row.서비스명),
      str(row['금액(원)']),
      str(row['소요시간(분)']),
      str(row.비고),
    );
    return this.getServiceById(row.ID);
  }

  deleteService(id) {
    return this.db.prepare('DELETE FROM services WHERE id = ?').run(str(id)).changes > 0;
  }

  // === Schedules ===
  getAllSchedules() {
    return this.db.prepare('SELECT * FROM schedules ORDER BY _seq ASC').all().map(LocalDatabase.mapSchedule);
  }

  getScheduleById(id) {
    return LocalDatabase.mapSchedule(this.db.prepare('SELECT * FROM schedules WHERE schedule_id = ?').get(str(id)));
  }

  upsertSchedule(row) {
    this.db.prepare(`
      INSERT INTO schedules (
        schedule_id, date, start_time, end_time, therapist, client, service, status, memo, registered_at,
        visit_checked, care_checked, payment_checked, reminder_sms_sent, admin_sms_sent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(schedule_id) DO UPDATE SET
        date = excluded.date,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        therapist = excluded.therapist,
        client = excluded.client,
        service = excluded.service,
        status = excluded.status,
        memo = excluded.memo,
        registered_at = excluded.registered_at,
        visit_checked = excluded.visit_checked,
        care_checked = excluded.care_checked,
        payment_checked = excluded.payment_checked,
        reminder_sms_sent = excluded.reminder_sms_sent,
        admin_sms_sent = excluded.admin_sms_sent
    `).run(
      str(row.일정ID),
      str(row.날짜),
      str(row.시작시간),
      str(row.종료시간),
      str(row.치료사),
      str(row.고객),
      str(row.서비스),
      str(row.상태 || '예약'),
      str(row.비고),
      str(row.등록일시),
      normalizeCheckStorage(row.방문확인),
      normalizeCheckStorage(row.관리확인),
      normalizeCheckStorage(row.수납확인),
      normalizeCheckStorage(row['예약문자 발송확인']),
      normalizeCheckStorage(row['관리자문자 발송확인']),
    );
    return this.getScheduleById(row.일정ID);
  }

  deleteSchedule(id) {
    return this.db.prepare('DELETE FROM schedules WHERE schedule_id = ?').run(str(id)).changes > 0;
  }

  // === Charts ===
  getAllCharts() {
    return this.db.prepare('SELECT * FROM charts ORDER BY _seq ASC').all().map(LocalDatabase.mapChart);
  }

  getChartByScheduleId(scheduleId) {
    return LocalDatabase.mapChart(
      this.db.prepare('SELECT * FROM charts WHERE schedule_id = ? ORDER BY _seq ASC LIMIT 1').get(str(scheduleId)),
    );
  }

  getChartById(chartId) {
    return LocalDatabase.mapChart(this.db.prepare('SELECT * FROM charts WHERE chart_id = ?').get(str(chartId)));
  }

  upsertChart(row) {
    this.db.prepare(`
      INSERT INTO charts (
        chart_id, schedule_id, date, therapist, client, service,
        treatment_content, evaluation, desk_note, director_note,
        client_response, next_plan, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chart_id) DO UPDATE SET
        schedule_id = excluded.schedule_id,
        date = excluded.date,
        therapist = excluded.therapist,
        client = excluded.client,
        service = excluded.service,
        treatment_content = excluded.treatment_content,
        evaluation = excluded.evaluation,
        desk_note = excluded.desk_note,
        director_note = excluded.director_note,
        client_response = excluded.client_response,
        next_plan = excluded.next_plan,
        created_at = excluded.created_at
    `).run(
      str(row.차팅ID),
      str(row.일정ID),
      str(row.날짜),
      str(row.치료사),
      str(row.고객),
      str(row.서비스),
      str(row['관리(시술)내용']),
      str(row.결과평가),
      str(row.데스크기재),
      str(row.대표님기재),
      str(row.고객반응),
      str(row.다음시술계획),
      str(row.작성일시),
    );
    return this.getChartById(row.차팅ID);
  }

  deleteChartsByScheduleId(scheduleId) {
    return this.db.prepare('DELETE FROM charts WHERE schedule_id = ?').run(str(scheduleId)).changes;
  }

  // === SMS Logs ===
  insertSmsLogs(rows) {
    if (!rows || !rows.length) return;
    this.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO sms_logs (
          sent_at, category, client, recipient_phone, message_content,
          message_id, message_type, result_code, result_message, test_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of rows) {
        stmt.run(
          str(r.발송일시),
          str(r.구분),
          str(r.고객),
          str(r.수신번호),
          str(r.메시지내용),
          str(r.메시지ID),
          str(r.문자유형),
          str(r.결과코드),
          str(r.결과메시지),
          str(r.테스트모드),
        );
      }
    });
  }

  getSmsLogs(limit = 1000) {
    const total = this.db.prepare('SELECT COUNT(*) AS cnt FROM sms_logs').get().cnt;
    const rows = this.db
      .prepare('SELECT * FROM sms_logs ORDER BY sent_at DESC, _seq DESC LIMIT ?')
      .all(Number(limit) || 1000)
      .map(LocalDatabase.mapSmsLog);
    return { rows, total };
  }

  getAllSmsLogsAsc() {
    return this.db.prepare('SELECT * FROM sms_logs ORDER BY _seq ASC').all().map(LocalDatabase.mapSmsLog);
  }

  // === Therapist Offs ===
  getAllOffs() {
    return this.db.prepare('SELECT * FROM therapist_offs ORDER BY _seq ASC').all().map(LocalDatabase.mapOff);
  }

  getOffById(id) {
    return LocalDatabase.mapOff(this.db.prepare('SELECT * FROM therapist_offs WHERE off_id = ?').get(str(id)));
  }

  upsertOff(row) {
    this.db.prepare(`
      INSERT INTO therapist_offs (off_id, date, therapist, start_time, end_time, memo, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(off_id) DO UPDATE SET
        date = excluded.date,
        therapist = excluded.therapist,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        memo = excluded.memo,
        registered_at = excluded.registered_at
    `).run(
      str(row.오프ID),
      str(row.날짜),
      str(row.치료사),
      str(row.시작시간),
      str(row.종료시간),
      str(row.비고),
      str(row.등록일시),
    );
    return this.getOffById(row.오프ID);
  }

  deleteOff(id) {
    return this.db.prepare('DELETE FROM therapist_offs WHERE off_id = ?').run(str(id)).changes > 0;
  }

  deleteOffsByTherapist(name) {
    const rows = this.db.prepare('SELECT off_id, therapist FROM therapist_offs').all();
    const target = str(name).trim();
    let count = 0;
    const del = this.db.prepare('DELETE FROM therapist_offs WHERE off_id = ?');
    for (const r of rows) {
      if (str(r.therapist).trim() === target) {
        del.run(r.off_id);
        count += 1;
      }
    }
    return count;
  }

  // === Table counts for UI status ===
  getCounts() {
    return {
      고객명단: this.db.prepare('SELECT COUNT(*) AS c FROM clients').get().c,
      치료사: this.db.prepare('SELECT COUNT(*) AS c FROM therapists').get().c,
      서비스목록: this.db.prepare('SELECT COUNT(*) AS c FROM services').get().c,
      일정: this.db.prepare('SELECT COUNT(*) AS c FROM schedules').get().c,
      차팅: this.db.prepare('SELECT COUNT(*) AS c FROM charts').get().c,
      문자발송내역: this.db.prepare('SELECT COUNT(*) AS c FROM sms_logs').get().c,
      설정: this.db.prepare('SELECT COUNT(*) AS c FROM settings').get().c,
      오프: this.db.prepare('SELECT COUNT(*) AS c FROM therapist_offs').get().c,
    };
  }
}

module.exports = { LocalDatabase };
