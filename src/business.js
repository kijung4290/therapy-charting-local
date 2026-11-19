'use strict';

const {
  APP_CONFIG,
  REQUIRED_FIELDS,
  kstTimestamp,
  kstToday,
  newId,
  fullUuid,
  replaceTemplate,
  koreanWeekday,
  hmacSha256Base64Url,
  isValidScheduleStatus,
} = require('./utils');
const {
  parseWorkbookBuffer,
  summarizeParsedWorkbook,
  importParsedWorkbook,
} = require('./migration');

const MUTATING_METHOD_SCOPES = {
  고객저장: ['bootstrap', 'charts'],
  고객삭제: ['bootstrap'],
  치료사저장: ['bootstrap', 'charts'],
  치료사삭제: ['bootstrap'],
  서비스저장: ['bootstrap'],
  서비스삭제: ['bootstrap'],
  기본서비스일괄저장: ['bootstrap'],
  일정저장: ['bootstrap', 'charts'],
  일정삭제: ['bootstrap', 'charts'],
  일정상태변경: ['bootstrap'],
  일정확인항목변경: ['bootstrap'],
  일정드래그변경: ['bootstrap', 'charts'],
  일정드래그복사: ['bootstrap'],
  오프저장: ['bootstrap'],
  오프삭제: ['bootstrap'],
  차팅저장: ['bootstrap', 'charts'],
  메시지미차팅문자발송: ['bootstrap'],
  스프레드시트가져오기: ['bootstrap', 'charts'],
};

class TherapyAppService {
  constructor(db, sms, options = {}) {
    this.db = db;
    this.sms = sms;
    this.onConfigChanged = options.onConfigChanged || null;
    this.getRuntimeInfo = options.getRuntimeInfo || (() => ({}));
    this.bootId = fullUuid().substring(0, 8);
    this.dataVersion = 1;
    this._changeListeners = new Set();
    if (this.sms && !this.sms.onDataChanged) {
      this.sms.onDataChanged = (info) => this.notifyDataChanged(info);
    }
  }

  getSyncState() {
    return {
      version: this.dataVersion,
      bootId: this.bootId,
    };
  }

  onDataChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    this._changeListeners.add(listener);
    return () => this._changeListeners.delete(listener);
  }

  notifyDataChanged(info = {}) {
    this.dataVersion += 1;
    const event = {
      version: this.dataVersion,
      bootId: this.bootId,
      method: String(info.method || ''),
      scopes: Array.isArray(info.scopes) && info.scopes.length ? info.scopes : ['bootstrap'],
      originClientId: String(info.originClientId || ''),
      at: kstTimestamp(),
    };
    for (const fn of this._changeListeners) {
      try { fn(event); } catch (_) {}
    }
    return event;
  }

  // === Auth & Token ===
  getMainPassword() {
    return this.db.getSetting('메인접속비밀번호', APP_CONFIG.메인접속비밀번호);
  }

  getAdminPassword() {
    return this.db.getSetting('관리자비밀번호', APP_CONFIG.관리자비밀번호);
  }

  getAdminSecretKey() {
    let key = this.db.getProperty('ADMIN_SECRET_KEY');
    if (!key) {
      key = fullUuid() + '_' + Date.now();
      this.db.setProperty('ADMIN_SECRET_KEY', key);
    }
    return key;
  }

  getAdminTokenGen() {
    return this.db.getProperty('ADMIN_TOKEN_GEN', '0') || '0';
  }

  bumpAdminTokenGen() {
    this.db.setProperty('ADMIN_TOKEN_GEN', String(Date.now()));
  }

  createAdminToken() {
    const ts = Date.now();
    const nonce = fullUuid().replace(/-/g, '');
    const gen = this.getAdminTokenGen();
    const raw = `${ts}.${nonce}.${gen}`;
    const signingKey = this.getAdminSecretKey() + '_' + this.getAdminPassword();
    const sig = hmacSha256Base64Url(raw, signingKey);
    return `${raw}.${sig}`;
  }

  verifyAdminToken(token) {
    if (!token || typeof token !== 'string' || token.length > 260) return false;
    try {
      const parts = token.split('.');
      if (parts.length !== 4) return false;
      const [tsStr, nonce, gen, sig] = parts;
      const ts = Number(tsStr);
      const now = Date.now();
      if (!ts || Number.isNaN(ts) || now - ts > 24 * 60 * 60 * 1000 || ts > now + 300000) {
        return false;
      }
      if (gen !== this.getAdminTokenGen()) return false;
      const signingKey = this.getAdminSecretKey() + '_' + this.getAdminPassword();
      const expected = hmacSha256Base64Url(`${tsStr}.${nonce}.${gen}`, signingKey);
      return expected === sig;
    } catch (_) {
      return false;
    }
  }

  // === Main RPC Router ===
  async dispatch(method, arg, meta = {}) {
    const result = await this._dispatchInternal(method, arg);
    const scopes = MUTATING_METHOD_SCOPES[method];
    if (scopes && result && result.success) {
      this.notifyDataChanged({
        method,
        scopes,
        originClientId: meta && meta.clientId ? String(meta.clientId) : '',
      });
    }
    return result;
  }

  async _dispatchInternal(method, arg) {
    switch (method) {
      case 'getBootstrapData': return this.getBootstrapData();
      case '차팅데이터조회': return this.getChartList();
      case '앱접속로그인': return this.appLogin(arg);
      case '관리자로그인': return this.adminLogin(arg);
      case '관리자확인': return this.checkAdmin(arg);
      case '메인접속비밀번호변경': return this.changeMainPassword(arg);
      case '관리자비밀번호변경': return this.changeAdminPassword(arg);

      case '고객저장': return this.saveClient(arg);
      case '고객삭제': return this.deleteClient(arg);
      case '치료사저장': return this.saveTherapist(arg);
      case '치료사삭제': return this.deleteTherapist(arg);
      case '서비스저장': return this.saveService(arg);
      case '서비스삭제': return this.deleteService(arg);
      case '기본서비스일괄저장': return this.bulkSaveDefaultServices(arg);

      case '일정저장': return this.saveSchedule(arg);
      case '일정삭제': return this.deleteSchedule(arg);
      case '일정상태변경': return this.changeScheduleStatus(arg);
      case '일정확인항목변경': return this.toggleScheduleCheck(arg);
      case '일정드래그변경': return this.dragMoveSchedule(arg);
      case '일정드래그복사': return this.dragCopySchedule(arg);

      case '오프저장': return this.saveOff(arg);
      case '오프삭제': return this.deleteOff(arg);

      case '차팅조회': return this.getChart(arg);
      case '차팅저장': return this.saveChart(arg);

      case '메시지미설정조회': return this.getSmsSettings(arg);
      case '메시지미설정저장': return this.saveSmsSettings(arg);
      case '메시지미발송내역조회': return this.getSmsLogs(arg);
      case '메시지미잔여캐시조회': return this.getSmsRemainingCash(arg);
      case '문자템플릿저장': return this.saveSmsTemplate(arg);
      case '문자템플릿삭제': return this.deleteSmsTemplate(arg);
      case '메시지미선택문자발송': return this.sendSelectedSms(arg);
      case '메시지미차팅문자발송': return this.sendChartSms(arg);
      case '자동문자트리거설치': return this.toggleAutoSms(arg, true);
      case '자동문자트리거해제': return this.toggleAutoSms(arg, false);

      // Local-app specific endpoints
      case '현재공인IP조회': return this.getPublicIp(arg);
      case '로컬상태조회': return this.getLocalStatus(arg);
      case '로컬설정저장': return this.saveLocalSettings(arg);
      case '로컬백업생성': return this.createLocalBackup(arg);
      case '스프레드시트미리보기': return this.previewSpreadsheet(arg);
      case '스프레드시트가져오기': return this.importSpreadsheet(arg);

      default:
        return { success: false, message: '지원하지 않는 요청입니다: ' + String(method || '') };
    }
  }

  // === Bootstrap & Chart list ===
  getBootstrapData() {
    try {
      return {
        success: true,
        data: {
          고객: this.db.getAllClients(),
          치료사: this.db.getAllTherapists(),
          서비스: this.db.getAllServices(),
          일정: this.db.getAllSchedules(),
          오프: this.db.getAllOffs(),
          오늘: kstToday(),
        },
      };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  getChartList() {
    try {
      return { success: true, data: this.db.getAllCharts() };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // === Auth ===
  appLogin(data = {}) {
    if (String(data.비밀번호 || '') === this.getMainPassword()) {
      return { success: true, data: { 인증됨: true } };
    }
    return { success: false, message: '메인 접속 비밀번호가 올바르지 않습니다' };
  }

  adminLogin(data = {}) {
    if (String(data.비밀번호 || '') === this.getAdminPassword()) {
      return { success: true, data: { 토큰: this.createAdminToken() } };
    }
    return { success: false, message: '비밀번호가 올바르지 않습니다' };
  }

  checkAdmin(data = {}) {
    return { success: true, data: { 유효: this.verifyAdminToken(data.토큰) } };
  }

  changeMainPassword(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    const next = String(data.새비밀번호 || '');
    if (next.length < 4) return { success: false, message: '새 메인 접속 비밀번호는 4자 이상 입력해 주세요' };
    if (next.length > 100) return { success: false, message: '비밀번호는 100자 이하로 입력해 주세요' };
    this.db.setSetting('메인접속비밀번호', next);
    return { success: true, message: '메인 접속 비밀번호가 변경되었습니다' };
  }

  changeAdminPassword(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '로그인이 필요합니다' };
    if (String(data.현재비밀번호 || '') !== this.getAdminPassword()) {
      return { success: false, message: '현재 비밀번호가 올바르지 않습니다' };
    }
    const next = String(data.새비밀번호 || '');
    if (next.length < 4) return { success: false, message: '새 비밀번호는 4자 이상 입력해 주세요' };
    if (next.length > 100) return { success: false, message: '비밀번호는 100자 이하로 입력해 주세요' };
    this.db.setSetting('관리자비밀번호', next);
    this.bumpAdminTokenGen();
    return {
      success: true,
      message: '관리자 비밀번호가 변경되었습니다',
      data: { 토큰: this.createAdminToken() },
    };
  }

  // === Helpers for linked records ===
  hasLinkedRecords(field, value) {
    const target = String(value || '').trim();
    if (!target) return false;
    const col = field === '고객' ? 'client' : 'therapist';
    const sched = this.db.db.prepare(`SELECT 1 FROM schedules WHERE TRIM(${col}) = ? LIMIT 1`).get(target);
    if (sched) return true;
    const chart = this.db.db.prepare(`SELECT 1 FROM charts WHERE TRIM(${col}) = ? LIMIT 1`).get(target);
    return !!chart;
  }

  syncChartScheduleSnapshot(scheduleId, schedule) {
    const existing = this.db.getChartByScheduleId(scheduleId);
    if (!existing) return null;
    existing.날짜 = schedule.날짜 || '';
    existing.치료사 = schedule.치료사 || '';
    existing.고객 = schedule.고객 || '';
    existing.서비스 = schedule.서비스 || '';
    return this.db.upsertChart(existing);
  }

  // === Clients ===
  async saveClient(data = {}) {
    const payload = { ...data, 이름: String(data.이름 || '').trim() };
    const isNew = !payload.id;
    if (!payload.이름) return { success: false, message: '이름을 입력해 주세요' };

    const result = this.db.transaction(() => {
      const clients = this.db.getAllClients();
      let existing = null;
      let duplicate = null;
      for (const c of clients) {
        if (payload.id && String(c.ID) === String(payload.id)) existing = c;
        if (String(c.이름 || '').trim() === payload.이름 && String(c.ID) !== String(payload.id || '')) {
          duplicate = c;
        }
      }
      if (payload.id && !existing) return { success: false, message: '수정할 고객을 찾을 수 없습니다' };
      if (duplicate) {
        return {
          success: false,
          message: '같은 이름의 고객이 이미 있습니다. 방문 이력을 정확히 연결하려면 고객명을 서로 다르게 입력해 주세요',
        };
      }

      const oldName = existing ? String(existing.이름 || '').trim() : '';
      const renamed = !!existing && oldName !== payload.이름;
      if (renamed) {
        const oldCount = clients.filter((c) => String(c.이름 || '').trim() === oldName).length;
        if (oldCount > 1) {
          return {
            success: false,
            message: '기존에 같은 이름의 고객이 여러 명이라 과거 기록을 안전하게 구분할 수 없습니다. 먼저 중복 고객 데이터를 확인해 주세요',
          };
        }
      }

      const saved = this.db.upsertClient({
        ID: existing ? existing.ID : newId(),
        등록일시: existing ? existing.등록일시 : kstTimestamp(),
        이름: payload.이름,
        생년월일: payload.생년월일 ?? '',
        성별: payload.성별 ?? '',
        연락처: payload.연락처 ?? '',
        주소: payload.주소 ?? '',
        특이사항: payload.특이사항 ?? '',
        비고: payload.비고 ?? '',
      });

      if (renamed) {
        const schedRes = this.db.db.prepare('UPDATE schedules SET client = ? WHERE TRIM(client) = ?').run(payload.이름, oldName);
        const chartRes = this.db.db.prepare('UPDATE charts SET client = ? WHERE TRIM(client) = ?').run(payload.이름, oldName);
        return {
          success: true,
          message: '고객 정보와 연결된 과거 일정·차팅을 함께 수정했습니다',
          data: {
            갱신: saved,
            이름변경: {
              기존이름: oldName,
              새이름: payload.이름,
              일정건수: schedRes.changes,
              차팅건수: chartRes.changes,
            },
          },
        };
      }

      return {
        success: true,
        message: existing ? '수정되었습니다' : '등록되었습니다',
        data: { 갱신: saved },
      };
    });

    if (!result.success || !isNew || !payload.문자발송) return result;

    try {
      const cfg = this.sms.getConfig();
      const content = replaceTemplate(cfg.신규고객문구, {
        기관명: cfg.기관명,
        고객명: payload.이름,
      });
      const smsRes = await this.sms.sendSingle('신규고객', payload.이름, payload.연락처, content, cfg);
      result.data = { 갱신: result.data && result.data.갱신, 문자: smsRes };
      result.message = smsRes.success
        ? '고객 등록 및 ' + smsRes.message
        : '고객은 등록되었지만 문자 발송에 실패했습니다: ' + smsRes.message;
    } catch (e) {
      result.message = '고객은 등록되었지만 문자 발송에 실패했습니다: ' + e.message;
    }
    return result;
  }

  deleteClient(id) {
    return this.db.transaction(() => {
      const existing = this.db.getClientById(id);
      if (!existing) return { success: false, message: '데이터를 찾을 수 없습니다' };
      if (this.hasLinkedRecords('고객', existing.이름)) {
        return {
          success: false,
          message: '일정 또는 차팅이 연결된 고객은 삭제할 수 없습니다. 고객 정보는 수정하여 관리해 주세요',
        };
      }
      this.db.deleteClient(id);
      return { success: true, message: '삭제되었습니다', data: { 삭제ID: String(id) } };
    });
  }

  // === Therapists ===
  saveTherapist(data = {}) {
    return this.db.transaction(() => {
      const name = String(data.이름 || '').trim();
      if (!name) return { success: false, message: '이름을 입력해 주세요' };
      const list = this.db.getAllTherapists();
      let existing = null;
      let duplicate = false;
      for (const t of list) {
        if (data.id && String(t.ID) === String(data.id)) existing = t;
        if (String(t.이름 || '').trim() === name && String(t.ID) !== String(data.id || '')) duplicate = true;
      }
      if (data.id && !existing) return { success: false, message: '데이터를 찾을 수 없습니다' };
      if (duplicate) return { success: false, message: '같은 이름의 담당자가 이미 있습니다' };

      const oldName = existing ? String(existing.이름 || '').trim() : '';
      const renamed = !!existing && oldName !== name;
      if (renamed) {
        const oldCount = list.filter((t) => String(t.이름 || '').trim() === oldName).length;
        if (oldCount > 1) {
          return {
            success: false,
            message: '같은 이름의 담당자가 여러 명이라 과거 기록을 안전하게 구분할 수 없습니다. 먼저 중복 담당자 데이터를 정리해 주세요',
          };
        }
      }

      const saved = this.db.upsertTherapist({
        ID: existing ? existing.ID : newId(),
        등록일시: existing ? existing.등록일시 : kstTimestamp(),
        이름: name,
        직책: data.직책 ?? '',
        연락처: data.연락처 ?? '',
        비고: data.비고 ?? '',
      });

      if (renamed) {
        const sRes = this.db.db.prepare('UPDATE schedules SET therapist = ? WHERE TRIM(therapist) = ?').run(name, oldName);
        const cRes = this.db.db.prepare('UPDATE charts SET therapist = ? WHERE TRIM(therapist) = ?').run(name, oldName);
        this.db.db.prepare('UPDATE therapist_offs SET therapist = ? WHERE TRIM(therapist) = ?').run(name, oldName);
        return {
          success: true,
          message: '담당자 정보와 연결된 과거 일정·차팅을 함께 수정했습니다',
          data: {
            갱신: saved,
            이름변경: { 기존이름: oldName, 새이름: name, 일정건수: sRes.changes, 차팅건수: cRes.changes },
          },
        };
      }

      return {
        success: true,
        message: existing ? '수정되었습니다' : '등록되었습니다',
        data: { 갱신: saved },
      };
    });
  }

  deleteTherapist(id) {
    return this.db.transaction(() => {
      const existing = this.db.getTherapistById(id);
      if (!existing) return { success: false, message: '데이터를 찾을 수 없습니다' };
      if (this.hasLinkedRecords('치료사', existing.이름)) {
        return {
          success: false,
          message: '일정 또는 차팅이 연결된 담당자는 삭제할 수 없습니다. 담당자 정보는 수정하여 관리해 주세요',
        };
      }
      this.db.deleteTherapist(id);
      const offCount = existing.이름 ? this.db.deleteOffsByTherapist(existing.이름) : 0;
      return {
        success: true,
        message: '삭제되었습니다',
        data: { 삭제ID: String(id), 오프삭제건수: offCount },
      };
    });
  }

  // === Services ===
  saveService(data = {}) {
    return this.db.transaction(() => {
      const req = REQUIRED_FIELDS.서비스목록;
      if (!String(data[req] || '').trim()) return { success: false, message: req + '을(를) 입력해 주세요' };
      const existing = data.id ? this.db.getServiceById(data.id) : null;
      if (data.id && !existing) return { success: false, message: '데이터를 찾을 수 없습니다' };
      const saved = this.db.upsertService({
        ID: existing ? existing.ID : newId(),
        등록일시: existing ? existing.등록일시 : kstTimestamp(),
        서비스명: String(data.서비스명).trim(),
        '금액(원)': data['금액(원)'] != null ? data['금액(원)'] : (data.금액 ?? ''),
        '소요시간(분)': data['소요시간(분)'] != null ? data['소요시간(분)'] : (data.소요시간 ?? ''),
        비고: data.비고 ?? '',
      });
      return {
        success: true,
        message: existing ? '수정되었습니다' : '등록되었습니다',
        data: { 갱신: saved },
      };
    });
  }

  deleteService(id) {
    return this.db.transaction(() => {
      if (!this.db.deleteService(id)) return { success: false, message: '데이터를 찾을 수 없습니다' };
      return { success: true, message: '삭제되었습니다', data: { 삭제ID: String(id) } };
    });
  }

  bulkSaveDefaultServices(data = {}) {
    return this.db.transaction(() => {
      const list = Array.isArray(data.목록) ? data.목록 : [];
      if (!list.length) return { success: false, message: '저장할 서비스 목록이 없습니다' };
      const existingNames = new Set(this.db.getAllServices().map((s) => String(s.서비스명).trim()));
      let added = 0;
      for (const item of list) {
        const name = String(item.서비스명 || '').trim();
        if (!name || existingNames.has(name)) continue;
        this.db.upsertService({
          ID: newId(),
          등록일시: kstTimestamp(),
          서비스명: name,
          '금액(원)': item['금액(원)'] || item.금액 || name,
          '소요시간(분)': item['소요시간(분)'] || item.소요시간 || '',
          비고: item.비고 || '',
        });
        existingNames.add(name);
        added += 1;
      }
      return {
        success: true,
        message: `${added}개 기본 서비스가 등록되었습니다`,
        data: this.db.getAllServices(),
      };
    });
  }

  // === Schedules ===
  async saveSchedule(data = {}) {
    const isNew = !data.id;
    const savedRes = this.db.transaction(() => {
      const status = String(data.상태 || '예약').trim();
      if (!isValidScheduleStatus(status)) return { success: false, message: '올바른 일정 상태를 선택해 주세요' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.날짜 || ''))) {
        return { success: false, message: '올바른 날짜를 선택해 주세요' };
      }
      const startTime = String(data.시작시간 || '');
      const endTime = String(data.종료시간 || '');
      if (!!startTime !== !!endTime) return { success: false, message: '시작시간과 종료시간을 모두 입력해 주세요' };
      if (startTime && (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || endTime <= startTime)) {
        return { success: false, message: '종료시간은 시작시간보다 뒤여야 합니다' };
      }
      if (!data.치료사) return { success: false, message: '담당자를 선택해 주세요' };
      if (!data.고객) return { success: false, message: '고객을 선택해 주세요' };
      const clientRow = this.db.db.prepare('SELECT 1 FROM clients WHERE TRIM(name) = ? LIMIT 1').get(String(data.고객).trim());
      if (!clientRow) return { success: false, message: '고객명단에 등록된 고객을 선택하거나 신규 등록해 주세요' };
      if (!data.서비스) return { success: false, message: '서비스를 선택해 주세요' };

      const id = data.id || newId();
      if (data.id) {
        const existing = this.db.getScheduleById(id);
        if (!existing) return { success: false, message: '일정을 찾을 수 없습니다' };
        const visitVal = data.방문확인 != null ? !!data.방문확인 : (data.방문 != null ? !!data.방문 : existing.방문확인);
        const careVal = data.관리확인 != null
          ? !!data.관리확인
          : (data.관리 != null || data.상담확인 != null ? !!(data.관리 != null ? data.관리 : data.상담확인) : existing.관리확인);
        const payVal = data.수납확인 != null ? !!data.수납확인 : (data.수납 != null ? !!data.수납 : existing.수납확인);
        const remVal = data['예약문자 발송확인'] != null ? !!data['예약문자 발송확인'] : existing['예약문자 발송확인'];
        const admVal = data['관리자문자 발송확인'] != null ? !!data['관리자문자 발송확인'] : existing['관리자문자 발송확인'];

        const updated = this.db.upsertSchedule({
          일정ID: id,
          날짜: data.날짜,
          시작시간: startTime,
          종료시간: endTime,
          치료사: data.치료사,
          고객: data.고객,
          서비스: data.서비스,
          상태: status,
          비고: data.비고 ?? '',
          등록일시: existing.등록일시,
          방문확인: visitVal,
          관리확인: careVal,
          수납확인: payVal,
          '예약문자 발송확인': remVal,
          '관리자문자 발송확인': admVal,
        });
        const chartUpdated = this.syncChartScheduleSnapshot(id, updated);
        if (status === '취소' || status === '노쇼') {
          this.sms.scheduleThanksSms(id, false);
          this.sms.clearReminderRetry(id);
        }
        return {
          success: true,
          message: '일정이 수정되었습니다',
          data: { 갱신: updated, 차팅갱신: chartUpdated },
        };
      }

      const created = this.db.upsertSchedule({
        일정ID: id,
        날짜: data.날짜,
        시작시간: startTime,
        종료시간: endTime,
        치료사: data.치료사,
        고객: data.고객,
        서비스: data.서비스,
        상태: status,
        비고: data.비고 ?? '',
        등록일시: kstTimestamp(),
        방문확인: data.방문확인 != null ? !!data.방문확인 : (data.방문 != null ? !!data.방문 : ''),
        관리확인: data.관리확인 != null ? !!data.관리확인 : (data.관리 != null ? !!data.관리 : (data.상담확인 != null ? !!data.상담확인 : '')),
        수납확인: data.수납확인 != null ? !!data.수납확인 : (data.수납 != null ? !!data.수납 : ''),
        '예약문자 발송확인': data['예약문자 발송확인'] == null ? '' : !!data['예약문자 발송확인'],
        '관리자문자 발송확인': data['관리자문자 발송확인'] == null ? '' : !!data['관리자문자 발송확인'],
      });
      return {
        success: true,
        message: '일정이 등록되었습니다',
        data: { 갱신: created },
      };
    });

    if (!savedRes.success || !data.문자발송) return savedRes;

    const status = String(data.상태 || '예약').trim();
    if (status !== '예약') {
      savedRes.message += ' (상태가 예약이 아니어서 문자는 발송하지 않았습니다)';
      return savedRes;
    }

    try {
      const cfg = this.sms.getConfig();
      const content = replaceTemplate(cfg.일정안내문구, {
        기관명: cfg.기관명,
        고객명: data.고객 || '',
        날짜: data.날짜 || '',
        요일: koreanWeekday(data.날짜),
        시작시간: data.시작시간 || '',
        종료시간: data.종료시간 || '',
        치료사: data.치료사 || '',
        담당자: data.치료사 || '',
        서비스: data.서비스 || '',
      });
      const phoneMap = this.sms.buildClientPhoneMap();
      const smsRes = await this.sms.sendSingle(
        isNew ? '일정등록' : '일정수정',
        data.고객 || '',
        phoneMap[String(data.고객 || '')] || '',
        content,
        cfg,
      );
      savedRes.data = savedRes.data || {};
      savedRes.data.문자 = smsRes;
      savedRes.message = smsRes.success
        ? savedRes.message + ' / ' + smsRes.message
        : savedRes.message + ', 문자 발송 실패: ' + smsRes.message;
    } catch (e) {
      savedRes.message += ', 문자 발송 실패: ' + e.message;
    }
    return savedRes;
  }

  deleteSchedule(data) {
    return this.db.transaction(() => {
      const id = data && typeof data === 'object' ? data.id : data;
      const deleteChartToo = !!(data && typeof data === 'object' && data.차팅함께삭제);
      const existing = this.db.getScheduleById(id);
      if (!existing) return { success: false, message: '일정을 찾을 수 없습니다' };

      const chart = this.db.getChartByScheduleId(id);
      if (chart) {
        if (String(existing.상태 || '').trim() !== '예약') {
          return {
            success: false,
            message: '작성된 차팅이 연결된 일정은 삭제할 수 없습니다. 기록 보존을 위해 취소 상태로 변경해 주세요',
          };
        }
        if (!deleteChartToo) {
          return {
            success: false,
            확인필요: true,
            message: '이 일정에 작성된 차팅이 있습니다. 차팅도 함께 삭제할까요?',
          };
        }
        this.db.deleteChartsByScheduleId(id);
      }

      this.sms.scheduleThanksSms(id, false);
      this.sms.clearReminderRetry(id);
      this.db.deleteSchedule(id);
      return {
        success: true,
        message: '일정이 삭제되었습니다',
        data: { 삭제ID: String(id), 차팅삭제: !!chart },
      };
    });
  }

  changeScheduleStatus(data = {}) {
    return this.db.transaction(() => {
      const id = String(data.id || data.일정ID || '').trim();
      if (!id) return { success: false, message: '일정 ID가 없습니다' };
      const existing = this.db.getScheduleById(id);
      if (!existing) return { success: false, message: '일정을 찾을 수 없습니다' };
      const nextStatus = String(data.상태 || '예약').trim();
      if (!isValidScheduleStatus(nextStatus)) return { success: false, message: '올바른 일정 상태가 아닙니다' };
      existing.상태 = nextStatus;
      const updated = this.db.upsertSchedule(existing);
      if (nextStatus === '취소' || nextStatus === '노쇼') {
        this.sms.scheduleThanksSms(id, false);
        this.sms.clearReminderRetry(id);
      }
      return {
        success: true,
        message: `일정 상태가 [${nextStatus}](으)로 변경되었습니다`,
        data: { 갱신: updated },
      };
    });
  }

  toggleScheduleCheck(data = {}) {
    return this.db.transaction(() => {
      const allowed = ['방문확인', '관리확인', '수납확인', '예약문자 발송확인', '관리자문자 발송확인', '방문', '관리', '수납', '상담확인'];
      if (!allowed.includes(data.항목)) return { success: false, message: '변경할 확인 항목이 올바르지 않습니다' };

      let target = data.항목;
      if (target === '방문') target = '방문확인';
      else if (target === '관리' || target === '상담' || target === '상담확인') target = '관리확인';
      else if (target === '수납') target = '수납확인';

      const existing = this.db.getScheduleById(data.id);
      if (!existing) return { success: false, message: '일정 또는 확인 항목을 찾을 수 없습니다' };
      if (['취소', '노쇼'].includes(String(existing.상태 || '').trim())) {
        return { success: false, message: '취소·노쇼 일정에서는 방문·관리·수납 확인을 변경할 수 없습니다' };
      }

      const checked = !!data.확인;
      existing[target] = checked;
      const updated = this.db.upsertSchedule(existing);
      if (target === '수납확인') this.sms.scheduleThanksSms(data.id, checked);
      if (target === '관리자문자 발송확인' && checked) this.sms.scheduleThanksSms(data.id, false);

      return {
        success: true,
        message: `${target}이 변경되었습니다`,
        data: { 갱신: updated },
      };
    });
  }

  dragMoveSchedule(data = {}) {
    return this.db.transaction(() => {
      const id = String(data.id || '').trim();
      if (!id) return { success: false, message: '일정 ID가 없습니다' };
      const existing = this.db.getScheduleById(id);
      if (!existing) return { success: false, message: '일정을 찾을 수 없습니다' };

      const d = String(data.날짜 || '');
      const st = String(data.시작시간 || '');
      const et = String(data.종료시간 || '');
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { success: false, message: '올바른 날짜가 아닙니다' };
      if ((st || et) && (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et) || et <= st)) {
        return { success: false, message: '종료시간은 시작시간보다 뒤여야 합니다' };
      }

      if (d) existing.날짜 = d;
      if (st) existing.시작시간 = st;
      if (et) existing.종료시간 = et;
      if (data.치료사) existing.치료사 = data.치료사;

      const updated = this.db.upsertSchedule(existing);
      const chartUpdated = this.syncChartScheduleSnapshot(id, updated);
      return {
        success: true,
        message: '일정이 변경되었습니다',
        data: { 갱신: updated, 차팅갱신: chartUpdated },
      };
    });
  }

  dragCopySchedule(data = {}) {
    return this.db.transaction(() => {
      const origId = String(data.원본ID || data.id || '').trim();
      if (!origId) return { success: false, message: '복사할 원본 일정 ID가 없습니다' };
      const orig = this.db.getScheduleById(origId);
      if (!orig) return { success: false, message: '원본 일정을 찾을 수 없습니다' };

      const created = this.db.upsertSchedule({
        일정ID: newId(),
        날짜: data.날짜 || orig.날짜,
        시작시간: data.시작시간 || orig.시작시간,
        종료시간: data.종료시간 || orig.종료시간,
        치료사: data.치료사 || orig.치료사,
        고객: orig.고객,
        서비스: orig.서비스,
        상태: '예약',
        비고: orig.비고 || '',
        등록일시: kstTimestamp(),
        방문확인: '',
        관리확인: '',
        수납확인: '',
        '예약문자 발송확인': '',
        '관리자문자 발송확인': '',
      });
      return {
        success: true,
        message: '일정이 복사되었습니다',
        data: { 갱신: created },
      };
    });
  }

  // === Therapist Offs ===
  saveOff(data = {}) {
    return this.db.transaction(() => {
      const date = String(data.날짜 || '');
      const therapist = String(data.치료사 || '').trim();
      const startTime = String(data.시작시간 || '');
      const endTime = String(data.종료시간 || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { success: false, message: '올바른 날짜를 선택해 주세요' };
      if (!therapist) return { success: false, message: '담당자를 선택해 주세요' };
      if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || endTime <= startTime) {
        return { success: false, message: '오프 종료시간은 시작시간보다 뒤여야 합니다' };
      }

      const id = String(data.id || '');
      const existing = id ? this.db.getOffById(id) : null;
      if (id && !existing) return { success: false, message: '오프 기록을 찾을 수 없습니다' };

      const saved = this.db.upsertOff({
        오프ID: existing ? existing.오프ID : newId(),
        날짜: date,
        치료사: therapist,
        시작시간: startTime,
        종료시간: endTime,
        비고: String(data.비고 || ''),
        등록일시: existing ? existing.등록일시 : kstTimestamp(),
      });
      return {
        success: true,
        message: `${therapist} 오프가 저장되었습니다`,
        data: { 갱신: saved },
      };
    });
  }

  deleteOff(id) {
    return this.db.transaction(() => {
      if (!this.db.deleteOff(id)) return { success: false, message: '오프 기록을 찾을 수 없습니다' };
      return { success: true, message: '오프가 삭제되었습니다', data: { 삭제ID: String(id) } };
    });
  }

  // === Charts ===
  getChart(data = {}) {
    try {
      const allCharts = this.db.getAllCharts();
      const statusMap = {};
      for (const s of this.db.getAllSchedules()) {
        if (s.일정ID) statusMap[String(s.일정ID)] = String(s.상태 || '').trim();
      }
      const scheduleId = String(data.일정ID || '');
      const current = allCharts.find((c) => String(c.일정ID) === scheduleId) || {};
      const schedule = this.db.getScheduleById(scheduleId);

      const clientName = String(current.고객 || (schedule && schedule.고객) || '').trim();
      const baseDate = String(current.날짜 || (schedule && schedule.날짜) || '');

      const prevCharts = allCharts
        .filter((r) => {
          const linkId = String(r.일정ID || '');
          const linkStatus = statusMap[linkId];
          const validLink = !linkId || (Object.prototype.hasOwnProperty.call(statusMap, linkId) && (linkStatus === '완료' || linkStatus === '예약완료'));
          return (
            validLink &&
            clientName &&
            String(r.고객 || '').trim() === clientName &&
            String(r.일정ID) !== scheduleId &&
            (!baseDate || String(r.날짜 || '') <= baseDate)
          );
        })
        .sort((a, b) => {
          const dCmp = String(b.날짜 || '').localeCompare(String(a.날짜 || ''));
          return dCmp || String(b.작성일시 || '').localeCompare(String(a.작성일시 || ''));
        });

      return {
        success: true,
        data: { ...current, 이전차팅목록: prevCharts },
      };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  saveChart(data = {}) {
    return this.db.transaction(() => {
      if (!data.일정ID) return { success: false, message: '일정 정보가 필요합니다' };
      const schedule = this.db.getScheduleById(data.일정ID);
      if (!schedule) return { success: false, message: '일정을 찾을 수 없습니다' };
      if (['취소', '노쇼'].includes(String(schedule.상태 || '').trim())) {
        return {
          success: false,
          message: '취소·노쇼 일정에는 차팅을 저장할 수 없습니다. 예약으로 복원한 뒤 저장해 주세요',
        };
      }

      const existing = this.db.getChartByScheduleId(data.일정ID);
      const savedChart = this.db.upsertChart({
        차팅ID: existing ? existing.차팅ID : newId(),
        일정ID: String(data.일정ID),
        날짜: schedule.날짜 || '',
        치료사: schedule.치료사 || '',
        고객: schedule.고객 || '',
        서비스: schedule.서비스 || '',
        '관리(시술)내용': data['관리(시술)내용'] || '',
        결과평가: data.결과평가 || '',
        데스크기재: data.데스크기재 != null ? data.데스크기재 : (data['데스크 기재'] || ''),
        대표님기재: data.대표님기재 != null ? data.대표님기재 : (data['대표님 기재'] || ''),
        고객반응: data.고객반응 || (existing ? existing.고객반응 || '' : ''),
        다음시술계획: data.다음시술계획 || (existing ? existing.다음시술계획 || '' : ''),
        작성일시: kstTimestamp(),
      });

      let updatedSchedule = schedule;
      if (!data.자동저장) {
        schedule.상태 = '완료';
        updatedSchedule = this.db.upsertSchedule(schedule);
      }

      return {
        success: true,
        message: data.자동저장 ? '차팅이 자동 저장되었습니다' : '차팅이 저장되었습니다',
        data: {
          차팅갱신: savedChart,
          일정갱신: updatedSchedule,
        },
      };
    });
  }

  // === SMS RPCs ===
  getSmsSettings(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    return this.sms.getSettingsResult();
  }

  saveSmsSettings(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    return this.sms.saveSettings(data);
  }

  getSmsLogs(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    return this.sms.getLogs(data);
  }

  async getSmsRemainingCash(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    return this.sms.remainingCash();
  }

  saveSmsTemplate(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    return this.sms.saveTemplate(data);
  }

  deleteSmsTemplate(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    return this.sms.deleteTemplate(data);
  }

  toggleAutoSms(data = {}, enabled) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    const res = this.sms.setAutoEnabled(enabled);
    if (res.success && this.onConfigChanged) this.onConfigChanged({ autoSmsEnabled: enabled });
    return res;
  }

  async sendSelectedSms(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    const targetType = String(data.대상유형 || '');
    const selectedIds = Array.isArray(data.선택ID) ? data.선택ID.map(String) : [];
    if (!selectedIds.length) return { success: false, message: '발송할 대상을 선택해 주세요' };
    if (selectedIds.length > 500) return { success: false, message: '한 번에 최대 500건까지 선택할 수 있습니다' };

    const selectedSet = new Set(selectedIds);
    const cfg = this.sms.getConfig();
    let template = String(data.문구 || '').trim();
    const items = [];

    if (targetType === '신규고객') {
      template = template || cfg.신규고객문구;
      for (const c of this.db.getAllClients()) {
        if (!selectedSet.has(String(c.ID))) continue;
        items.push({
          고객명: c.이름 || '',
          수신번호: c.연락처 || '',
          내용: replaceTemplate(template, { 기관명: cfg.기관명, 고객명: c.이름 || '' }),
        });
      }
    } else if (targetType === '예약고객') {
      template = template || cfg.일정안내문구;
      const phoneMap = this.sms.buildClientPhoneMap();
      for (const s of this.db.getAllSchedules()) {
        if (!selectedSet.has(String(s.일정ID))) continue;
        if (String(s.상태 || '').trim() === '취소') continue;
        items.push({
          고객명: s.고객 || '',
          수신번호: phoneMap[String(s.고객 || '')] || '',
          내용: replaceTemplate(template, this.sms.scheduleTemplateValues(s, cfg)),
        });
      }
    } else {
      return { success: false, message: '올바른 발송 대상 유형이 아닙니다' };
    }

    if (items.length !== selectedIds.length) {
      return { success: false, message: '선택 항목 중 삭제되었거나 취소된 일정이 있습니다. 목록을 새로고침해 주세요' };
    }

    return this.sms.sendBulk(targetType === '신규고객' ? '신규고객 일괄' : '일정안내 일괄', items);
  }

  async sendChartSms(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    const scheduleId = String(data.일정ID || '').trim();
    if (!scheduleId) return { success: false, message: '일정 ID가 없습니다' };
    const schedule = this.db.getScheduleById(scheduleId);
    if (!schedule) return { success: false, message: '일정을 찾을 수 없습니다' };

    const text = String(data.문구 || '').trim();
    if (!text) return { success: false, message: '발송 문구를 입력해 주세요' };

    const cfg = this.sms.getConfig();
    const rendered = replaceTemplate(text, this.sms.scheduleTemplateValues(schedule, cfg));
    const phoneMap = this.sms.buildClientPhoneMap();
    const phone = phoneMap[String(schedule.고객 || '')] || '';

    const res = await this.sms.sendSingle('차팅문자', schedule.고객 || '', phone, rendered, cfg);
    if (res.success) {
      this.sms.markScheduleSmsFlag(scheduleId, '예약문자 발송확인', false);
      res.data = { ...(res.data || {}), 갱신: this.db.getScheduleById(scheduleId) };
    }
    return res;
  }

  // === Local App Extra RPCs ===
  async getPublicIp(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    return this.sms.getPublicIp();
  }

  getLocalStatus(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    const props = this.db.getAllProperties();
    return {
      success: true,
      data: {
        건수: this.db.getCounts(),
        백업목록: this.db.listBackups(),
        데이터경로: this.db.dbPath,
        백업폴더: this.db.backupDir || '',
        원내공유활성: props.LAN_SHARE_ENABLED === 'Y',
        트레이상주: props.TRAY_ON_CLOSE !== 'N',
        부팅자동실행: props.AUTO_START_ENABLED === 'Y',
        자동실행트레이시작: props.AUTO_START_HIDDEN !== 'N',
        자동문자활성: props.AUTO_SMS_ENABLED === 'Y',
        ...this.getRuntimeInfo(),
      },
    };
  }

  async saveLocalSettings(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    const lanEnabled = !!data.원내공유활성;
    const trayOnClose = data.트레이상주 !== false;
    const autoStartEnabled = !!data.부팅자동실행;
    const autoStartHidden = data.자동실행트레이시작 !== false;
    this.db.setProperties({
      LAN_SHARE_ENABLED: lanEnabled ? 'Y' : 'N',
      TRAY_ON_CLOSE: trayOnClose ? 'Y' : 'N',
      AUTO_START_ENABLED: autoStartEnabled ? 'Y' : 'N',
      AUTO_START_HIDDEN: autoStartHidden ? 'Y' : 'N',
    });
    if (this.onConfigChanged) {
      await this.onConfigChanged({ lanEnabled, trayOnClose, autoStartEnabled, autoStartHidden });
    }
    const notes = [];
    if (autoStartEnabled) notes.push('PC 부팅 시 자동 실행 켜짐');
    if (lanEnabled) notes.push('원내 공유 켜짐');
    return {
      success: true,
      message: '로컬 앱 설정이 저장되었습니다' + (notes.length ? ` (${notes.join(' · ')})` : ''),
      data: {
        원내공유활성: lanEnabled,
        트레이상주: trayOnClose,
        부팅자동실행: autoStartEnabled,
        자동실행트레이시작: autoStartHidden,
        ...this.getRuntimeInfo(),
      },
    };
  }

  createLocalBackup(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    const backup = this.db.createBackup('manual');
    if (!backup) return { success: false, message: '메모리 모드에서는 파일 백업을 생성할 수 없습니다' };
    return {
      success: true,
      message: `백업 파일이 생성되었습니다: ${backup.fileName}`,
      data: { 백업: backup, 백업목록: this.db.listBackups() },
    };
  }

  previewSpreadsheet(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    try {
      const b64 = String(data.파일Base64 || '');
      if (!b64) return { success: false, message: '업로드된 파일 데이터가 없습니다' };
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 50 * 1024 * 1024) {
        return { success: false, message: '파일 크기는 50MB 이하만 업로드할 수 있습니다' };
      }
      const parsed = parseWorkbookBuffer(buf, String(data.파일명 || 'spreadsheet.xlsx'));
      return {
        success: true,
        data: summarizeParsedWorkbook(parsed),
      };
    } catch (e) {
      return { success: false, message: '스프레드시트 파일을 읽지 못했습니다: ' + e.message };
    }
  }

  importSpreadsheet(data = {}) {
    if (!this.verifyAdminToken(data.토큰)) return { success: false, message: '관리자 로그인이 필요합니다' };
    try {
      const b64 = String(data.파일Base64 || '');
      if (!b64) return { success: false, message: '업로드된 파일 데이터가 없습니다' };
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 50 * 1024 * 1024) {
        return { success: false, message: '파일 크기는 50MB 이하만 업로드할 수 있습니다' };
      }
      const parsed = parseWorkbookBuffer(buf, String(data.파일명 || 'spreadsheet.xlsx'));
      const res = importParsedWorkbook(this.db, parsed, {
        모드: data.모드 === 'merge' ? 'merge' : 'replace',
        설정포함: data.설정포함 !== false,
      });
      if (res.success && data.설정포함 !== false && parsed.감지시트.includes('설정')) {
        // Re-issue a fresh admin token signed with the possibly imported admin password so the operator stays logged in seamlessly
        this.bumpAdminTokenGen();
        res.data.새토큰 = this.createAdminToken();
      }
      return res;
    } catch (e) {
      return { success: false, message: '스프레드시트 데이터 이전에 실패했습니다: ' + e.message };
    }
  }
}

module.exports = { TherapyAppService };
