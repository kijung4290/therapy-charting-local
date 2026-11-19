'use strict';

const {
  DEFAULT_SMS_API_URL,
  DEFAULT_SMS_CONFIG,
  cleanPhone,
  isValidPhone,
  cleanSmsContent,
  smsBytes,
  replaceTemplate,
  koreanWeekday,
  kstTimestamp,
  kstToday,
  kstDateFromMs,
  parseKstDateTimeMs,
  isTruthyCheck,
  fullUuid,
} = require('./utils');

const ALLOWED_TEMPLATE_TARGETS = ['신규고객', '예약고객', '전체고객', '선택고객'];

const RESULT_CODE_DESC = {
  '100': '발송 요청 접수 완료',
  '155': 'API Key 또는 회원 상태 오류',
  '185': '잔여 캐시 부족',
  '225': '문자 내용 길이 오류',
  '315': '등록되지 않은 발신번호',
  '335': '수신번호 허용치 초과',
  '999': '서비스 종료',
};

function templatePropKey(id) {
  return 'MESSAGEME_TEMPLATE_CONTENT_' + String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function autoSmsPropKey(kind, scheduleId) {
  return 'AUTO_SMS_' + kind + '_' + String(scheduleId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SmsService {
  constructor(db, options = {}) {
    this.db = db;
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs || 15000;
    this.retryDelayMs = options.retryDelayMs != null ? options.retryDelayMs : 1500;
    this.onDataChanged = options.onDataChanged || null;
    this._autoRunning = false;
  }

  getConfig(props) {
    const p = props || this.db.getAllProperties();
    return {
      apiKey: p.MESSAGEME_API_KEY || '',
      sender: p.MESSAGEME_CALLBACK || '',
      기관명: p.MESSAGEME_ORG_NAME || DEFAULT_SMS_CONFIG.기관명,
      테스트모드: p.MESSAGEME_TEST_MODE === 'N' ? 'N' : 'Y',
      신규고객문구: p.MESSAGEME_WELCOME_TEMPLATE || DEFAULT_SMS_CONFIG.신규고객문구,
      일정안내문구: String(p.MESSAGEME_SCHEDULE_TEMPLATE || DEFAULT_SMS_CONFIG.일정안내문구).replace(/\{치료사\}/g, '{담당자}'),
      apiBaseUrl: String(p.MESSAGEME_API_BASE_URL || DEFAULT_SMS_API_URL).trim().replace(/\/+$/, ''),
    };
  }

  getDefaultTemplates(props) {
    const cfg = this.getConfig(props);
    return [
      { id: 'template_welcome', 이름: '신규 고객 기본 안내', 대상유형: '신규고객', 내용: cfg.신규고객문구 },
      { id: 'template_schedule', 이름: '예약 고객 기본 안내', 대상유형: '예약고객', 내용: cfg.일정안내문구 },
      { id: 'template_auto_reminder', 이름: '24시간 전 일정 재확인', 대상유형: '예약고객', 내용: DEFAULT_SMS_CONFIG.예약재확인문구 },
      { id: 'template_auto_thanks', 이름: '수납 후 이용 감사', 대상유형: '예약고객', 내용: DEFAULT_SMS_CONFIG.이용감사문구 },
    ];
  }

  getTemplates(props) {
    const all = props || this.db.getAllProperties();
    const raw = all.MESSAGEME_TEMPLATES_JSON;
    if (raw == null || raw === '') return this.getDefaultTemplates(all);

    let list;
    try {
      list = JSON.parse(raw);
    } catch (_) {
      list = this.getDefaultTemplates(all);
    }
    if (!Array.isArray(list)) list = [];

    const cleaned = list
      .filter((t) => t && t.id && t.이름 && ALLOWED_TEMPLATE_TARGETS.includes(t.대상유형))
      .map((t) => ({
        id: String(t.id),
        이름: String(t.이름),
        대상유형: String(t.대상유형),
        내용: String(t.내용 != null ? t.내용 : all[templatePropKey(t.id)] || '').replace(/\{치료사\}/g, '{담당자}'),
      }))
      .filter((t) => !!t.내용);

    for (const def of this.getDefaultTemplates(all)) {
      if (!def.id.startsWith('template_auto_')) continue;
      if (!cleaned.some((item) => String(item.id) === String(def.id))) {
        cleaned.push(def);
      }
    }
    return cleaned;
  }

  getAutoTemplateContent(id, props) {
    const list = this.getTemplates(props);
    const found = list.find((item) => String(item.id) === String(id));
    if (found) return String(found.내용 || '');
    return id === 'template_auto_thanks' ? DEFAULT_SMS_CONFIG.이용감사문구 : DEFAULT_SMS_CONFIG.예약재확인문구;
  }

  saveTemplateList(list) {
    this.db.transaction(() => {
      const index = list.map((t) => {
        this.db.setProperty(templatePropKey(t.id), String(t.내용 || ''));
        return { id: t.id, 이름: t.이름, 대상유형: t.대상유형 };
      });
      this.db.setProperty('MESSAGEME_TEMPLATES_JSON', JSON.stringify(index));
    });
  }

  saveTemplate(data) {
    const id = String(data.id || '').trim();
    const 이름 = String(data.이름 || '').trim();
    const 대상유형 = String(data.대상유형 || '');
    const 내용 = String(data.내용 || '').trim().replace(/\{치료사\}/g, '{담당자}');
    if (!이름) return { success: false, message: '템플릿 이름을 입력해 주세요' };
    if (이름.length > 50) return { success: false, message: '템플릿 이름은 50자 이하로 입력해 주세요' };
    if (!ALLOWED_TEMPLATE_TARGETS.includes(대상유형)) return { success: false, message: '템플릿 대상 유형을 선택해 주세요' };
    if (!내용) return { success: false, message: '발송 문구를 입력해 주세요' };
    if (내용.length > 2000) return { success: false, message: '발송 문구는 2,000자 이하로 입력해 주세요' };

    let list = this.getTemplates();
    const saveId = id || fullUuid();
    let found = false;
    list = list.map((t) => {
      if (String(t.id) !== saveId) return t;
      found = true;
      return { id: saveId, 이름, 대상유형, 내용 };
    });
    if (id && !found) return { success: false, message: '수정할 템플릿을 찾을 수 없습니다' };
    if (!id) {
      if (list.length >= 30) return { success: false, message: '템플릿은 최대 30개까지 저장할 수 있습니다' };
      list.push({ id: saveId, 이름, 대상유형, 내용 });
    }

    this.saveTemplateList(list);
    return {
      success: true,
      message: id ? '템플릿이 수정되었습니다' : '템플릿이 저장되었습니다',
      data: { 목록: list, 저장ID: saveId },
    };
  }

  deleteTemplate(data) {
    const id = String(data.id || '').trim();
    if (!id) return { success: false, message: '삭제할 템플릿 정보가 없습니다' };
    const existing = this.getTemplates();
    const next = existing.filter((t) => String(t.id) !== id);
    if (next.length === existing.length) return { success: false, message: '삭제할 템플릿을 찾을 수 없습니다' };
    this.saveTemplateList(next);
    this.db.deleteProperty(templatePropKey(id));
    return { success: true, message: '템플릿이 삭제되었습니다', data: { 목록: next } };
  }

  getSettingsResult() {
    const all = this.db.getAllProperties();
    const cfg = this.getConfig(all);
    return {
      success: true,
      data: {
        설정됨: !!(cfg.apiKey && cfg.sender),
        sender: cfg.sender,
        기관명: cfg.기관명,
        테스트모드: cfg.테스트모드,
        신규고객문구: cfg.신규고객문구,
        일정안내문구: cfg.일정안내문구,
        apiBaseUrl: cfg.apiBaseUrl,
        자동문자활성: all.AUTO_SMS_ENABLED === 'Y',
        템플릿: this.getTemplates(all),
      },
    };
  }

  saveSettings(data) {
    const existing = this.getConfig();
    const apiKey = String(data.apiKey || '').trim() || existing.apiKey;
    const sender = cleanPhone(data.sender);
    if (!apiKey) return { success: false, message: 'API Key를 입력해 주세요' };
    if (!/^[0-9]{8,16}$/.test(sender)) return { success: false, message: '메세지미에 등록된 발신번호를 확인해 주세요' };

    const apiBaseUrl = String(data.apiBaseUrl || '').trim();
    if (apiBaseUrl && !/^https?:\/\/.+/i.test(apiBaseUrl)) {
      return { success: false, message: 'API 서버 주소는 http:// 또는 https://로 시작해야 합니다' };
    }

    const propsToSave = {
      MESSAGEME_API_KEY: apiKey,
      MESSAGEME_CALLBACK: sender,
      MESSAGEME_ORG_NAME: String(data.기관명 || '').trim() || DEFAULT_SMS_CONFIG.기관명,
      MESSAGEME_TEST_MODE: data.테스트모드 === 'N' ? 'N' : 'Y',
      MESSAGEME_WELCOME_TEMPLATE: String(data.신규고객문구 || '').trim() || DEFAULT_SMS_CONFIG.신규고객문구,
      MESSAGEME_SCHEDULE_TEMPLATE: String(data.일정안내문구 || '').trim() || DEFAULT_SMS_CONFIG.일정안내문구,
    };
    if (data.apiBaseUrl !== undefined) {
      propsToSave.MESSAGEME_API_BASE_URL = apiBaseUrl || DEFAULT_SMS_API_URL;
    }

    this.db.setProperties(propsToSave);
    return { success: true, message: '메세지미 문자 설정이 저장되었습니다' };
  }

  setAutoEnabled(enabled) {
    if (enabled) {
      const cfg = this.getConfig();
      if (!cfg.apiKey || !cfg.sender) {
        return { success: false, message: '메세지미 문자 설정을 먼저 저장해 주세요' };
      }
      this.db.setProperty('AUTO_SMS_ENABLED', 'Y');
      return { success: true, message: '자동문자가 활성화되었습니다 (프로그램 실행 중 1분마다 자동 확인)', data: { 활성: true } };
    }
    this.db.setProperty('AUTO_SMS_ENABLED', 'N');
    return { success: true, message: '자동문자가 중지되었습니다', data: { 활성: false } };
  }

  scheduleThanksSms(scheduleId, enabled) {
    const key = autoSmsPropKey('THANKS_DUE', scheduleId);
    if (enabled) {
      this.db.setProperty(key, String(Date.now() + 5 * 60 * 1000));
    } else {
      this.db.deleteProperty(key);
    }
  }

  clearReminderRetry(scheduleId) {
    this.db.deleteProperty(autoSmsPropKey('REMINDER_RETRY', scheduleId));
  }

  getLogs(data = {}) {
    const maxCount = Number(data.최대건수) > 0 ? Math.min(Number(data.최대건수), 5000) : 1000;
    const { rows, total } = this.db.getSmsLogs(maxCount);
    return {
      success: true,
      data: rows,
      전체건수: total,
      표시상한: maxCount,
    };
  }

  static isConnectFailure(err) {
    const msg = String((err && err.message) || err || '');
    const code = String((err && err.cause && err.cause.code) || (err && err.code) || '');
    if (/timeout|timed out|aborted/i.test(msg) || (err && err.name === 'TimeoutError') || (err && err.name === 'AbortError')) {
      return false;
    }
    return (
      /address unavailable|dns error|unknown host|unreachable|connection refused|failed to connect|enotfound|econnrefused|ehostunreach/i.test(
        msg + ' ' + code,
      )
    );
  }

  static formatUserError(err) {
    const msg = String((err && err.message) || err || '');
    if (/timeout|timed out|aborted/i.test(msg) || (err && (err.name === 'TimeoutError' || err.name === 'AbortError'))) {
      return '문자 서버 응답이 늦어 결과를 확인하지 못했습니다. 실제로는 발송됐을 수 있으니 문자 발송내역을 확인한 뒤 필요할 때만 다시 보내 주세요. (' + msg + ')';
    }
    if (SmsService.isConnectFailure(err)) {
      return '문자 서버(메세지미)에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 잠시 후 다시 시도해 주세요. (' + msg + ')';
    }
    return msg;
  }

  static describeResult(result) {
    const code = String(result && result.result != null ? result.result : '');
    return (result && result.message) || RESULT_CODE_DESC[code] || (code ? '오류 코드 ' + code : '응답 코드 없음');
  }

  static buildSendPayload(cfg, recipient, content, type) {
    const payload = {
      api_key: cfg.apiKey,
      msg: content,
      callback: cleanPhone(cfg.sender),
      dstaddr: recipient,
      send_reserve: '0',
      call_block: '0',
    };
    if (type === 'LMS') payload.subject = cfg.기관명 + ' 안내';
    return payload;
  }

  async providerRequest(apiPath, payload, cfgInput) {
    const cfg = cfgInput || this.getConfig();
    const url = cfg.apiBaseUrl + apiPath;
    const body = new URLSearchParams(payload).toString();
    const doFetch = () =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
        },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

    let response;
    try {
      response = await doFetch();
    } catch (err) {
      if (!SmsService.isConnectFailure(err)) throw err;
      await sleep(this.retryDelayMs);
      response = await doFetch();
    }

    const rawText = String(await response.text()).replace(/^\uFEFF/, '').trim();
    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch (_) {
      parsed = null;
    }

    if (response.status === 403) {
      throw new Error(
        '메세지미 발송지 IP 미등록 차단 (HTTP 403): [문자 설정]에서 현재 PC 공인 IP를 확인해 메세지미에 사전 등록해 주세요.' +
          (parsed && parsed.message ? ' (' + parsed.message + ')' : ''),
      );
    }

    if (!response.ok) {
      const detail = (parsed && parsed.message) || rawText.slice(0, 200) || response.statusText;
      throw new Error(`메세지미 통신 오류 (HTTP ${response.status}): ${detail}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`메세지미 응답을 해석할 수 없습니다. (HTTP ${response.status})`);
    }
    return parsed;
  }

  async remainingCash() {
    try {
      const cfg = this.getConfig();
      if (!cfg.apiKey) return { success: false, message: '메세지미 설정을 먼저 저장해 주세요' };
      const result = await this.providerRequest('/remainCash', { api_key: cfg.apiKey }, cfg);
      if (result.remainCash == null) {
        return { success: false, message: '잔여 캐시 조회 실패: ' + SmsService.describeResult(result) };
      }
      return { success: true, data: { remainCash: result.remainCash } };
    } catch (err) {
      return { success: false, message: SmsService.formatUserError(err) };
    }
  }

  async getPublicIp() {
    const endpoints = [
      { url: 'https://api4.ipify.org?format=json', parse: (t) => JSON.parse(t).ip },
      { url: 'https://ipv4.icanhazip.com', parse: (t) => t.trim() },
    ];
    for (const ep of endpoints) {
      try {
        const res = await this.fetchImpl(ep.url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const text = await res.text();
        const ip = String(ep.parse(text) || '').trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          return { success: true, data: { ip } };
        }
      } catch (_) {}
    }
    return { success: false, message: '현재 PC의 공인 IP를 확인하지 못했습니다. 인터넷 연결을 확인해 주세요.' };
  }

  logEntries(category, items, msgId, msgType, resultCode, resultMessage, testMode) {
    try {
      const now = kstTimestamp();
      const rows = (items || []).map((item) => ({
        발송일시: now,
        구분: category,
        고객: item.고객명 || item.고객 || '',
        수신번호: item.수신번호 || item.받는번호 || '',
        메시지내용: item.내용 || item.메시지내용 || '',
        메시지ID: msgId || '',
        문자유형: msgType === 'AUTO' && item.문자유형 ? item.문자유형 : msgType,
        결과코드: String(resultCode == null ? '' : resultCode),
        결과메시지: String(resultMessage == null ? '' : resultMessage),
        테스트모드: testMode || '',
      }));
      this.db.insertSmsLogs(rows);
    } catch (_) {}
  }

  async sendSingle(category, clientName, recipientPhone, content, cfgInput) {
    const cfg = cfgInput || this.getConfig();
    if (!cfg.apiKey || !cfg.sender) {
      return { success: false, message: '메세지미 설정에서 API Key와 발신번호를 먼저 입력해 주세요' };
    }
    const phone = cleanPhone(recipientPhone);
    if (!isValidPhone(phone)) {
      return { success: false, message: '고객 연락처가 올바르지 않아 문자를 보내지 못했습니다' };
    }
    const message = cleanSmsContent(content);
    if (!message) return { success: false, message: '발송할 문자 내용이 없습니다' };
    const bytes = smsBytes(message);
    if (bytes > 2000) return { success: false, message: '문자 내용이 2,000Byte를 초과합니다' };
    const type = bytes <= 90 ? 'SMS' : 'LMS';

    try {
      if (cfg.테스트모드 === 'Y') {
        this.logEntries(category, [{ 고객명: clientName, 수신번호: phone, 내용: message }], '', type, 'TEST', '모의 발송(외부 API 호출 없음)', 'Y');
        return {
          success: true,
          message: `안내문자 모의 발송이 완료되었습니다 (${type} 1건)`,
          msgId: '',
          msgType: type,
          testMode: true,
        };
      }

      const result = await this.providerRequest('/sms_send', SmsService.buildSendPayload(cfg, phone, message, type), cfg);
      const ok = String(result.result) === '100';
      const desc = SmsService.describeResult(result);
      this.logEntries(category, [{ 고객명: clientName, 수신번호: phone, 내용: message }], '', result.msg_type || type, result.result || '', desc, 'N');
      return {
        success: ok,
        message: ok
          ? `안내문자 ${type} 1건이 접수되었습니다. 최종 결과는 메세지미 발송내역에서 확인해 주세요`
          : '메세지미 발송 실패: ' + desc,
        msgId: '',
        msgType: result.msg_type || type,
        testMode: false,
      };
    } catch (err) {
      this.logEntries(category, [{ 고객명: clientName, 수신번호: phone, 내용: message }], '', type, '통신오류', err.message, cfg.테스트모드);
      return { success: false, message: SmsService.formatUserError(err) };
    }
  }

  async sendBulk(category, sourceItems) {
    const cfg = this.getConfig();
    if (!cfg.apiKey || !cfg.sender) {
      return { success: false, message: '메세지미 설정에서 API Key와 발신번호를 먼저 입력해 주세요' };
    }
    if (!sourceItems || !sourceItems.length) return { success: false, message: '발송할 대상을 선택해 주세요' };
    if (sourceItems.length > 500) return { success: false, message: '대량 문자는 한 번에 최대 500건까지 발송할 수 있습니다' };

    const errors = [];
    const items = sourceItems.map((orig) => {
      const item = {
        고객명: orig.고객명 || '',
        수신번호: cleanPhone(orig.수신번호),
        내용: cleanSmsContent(orig.내용),
      };
      if (!isValidPhone(item.수신번호)) errors.push(item.고객명 + '(연락처 오류)');
      const bytes = smsBytes(item.내용);
      if (!item.내용) errors.push(item.고객명 + '(내용 없음)');
      if (bytes > 2000) errors.push(item.고객명 + '(2,000Byte 초과)');
      item.문자유형 = bytes <= 90 ? 'SMS' : 'LMS';
      return item;
    });

    if (errors.length) {
      return {
        success: false,
        message:
          '발송할 수 없는 항목이 있습니다: ' +
          errors.slice(0, 5).join(', ') +
          (errors.length > 5 ? ' 외 ' + (errors.length - 5) + '건' : ''),
      };
    }

    const smsRequested = items.filter((i) => i.문자유형 === 'SMS').length;
    const lmsRequested = items.length - smsRequested;

    try {
      if (cfg.테스트모드 === 'Y') {
        this.logEntries(category, items, '', 'AUTO', 'TEST', '모의 발송(외부 API 호출 없음)', 'Y');
        return {
          success: true,
          message: `모의 발송 완료: SMS ${smsRequested}건, LMS ${lmsRequested}건`,
          data: {
            요청건수: items.length,
            SMS요청건수: smsRequested,
            LMS요청건수: lmsRequested,
            성공건수: items.length,
            실패건수: 0,
            SMS성공건수: smsRequested,
            LMS성공건수: lmsRequested,
            테스트모드: true,
          },
        };
      }

      const groupMap = new Map();
      for (const item of items) {
        const key = `${item.문자유형}\u0001${item.내용}`;
        if (!groupMap.has(key)) {
          groupMap.set(key, { 내용: item.내용, 문자유형: item.문자유형, 항목들: [] });
        }
        groupMap.get(key).항목들.push(item);
      }
      const groups = [...groupMap.values()];

      let successCount = 0;
      let failCount = 0;
      let smsSuccess = 0;
      let lmsSuccess = 0;
      const batchSize = 50;

      for (let start = 0; start < groups.length; start += batchSize) {
        const chunk = groups.slice(start, start + batchSize);
        const settledList = await Promise.allSettled(
          chunk.map(async (group) => {
            const dstaddr = group.항목들.map((i) => i.수신번호).join('|');
            const result = await this.providerRequest(
              '/sms_send',
              SmsService.buildSendPayload(cfg, dstaddr, group.내용, group.문자유형),
              cfg,
            );
            return { group, result };
          }),
        );

        const logsToWrite = [];
        const now = kstTimestamp();
        settledList.forEach((settled, idx) => {
          const group = chunk[idx];
          if (settled.status === 'fulfilled') {
            const result = settled.value.result;
            const ok = String(result.result) === '100';
            const desc = SmsService.describeResult(result);
            if (ok) {
              successCount += group.항목들.length;
              if (group.문자유형 === 'SMS') smsSuccess += group.항목들.length;
              else lmsSuccess += group.항목들.length;
            } else {
              failCount += group.항목들.length;
            }
            for (const item of group.항목들) {
              logsToWrite.push({
                발송일시: now,
                구분: category,
                고객: item.고객명,
                수신번호: item.수신번호,
                메시지내용: item.내용,
                메시지ID: '',
                문자유형: result.msg_type || group.문자유형,
                결과코드: String(result.result || ''),
                결과메시지: desc,
                테스트모드: 'N',
              });
            }
          } else {
            failCount += group.항목들.length;
            const errMsg = SmsService.formatUserError(settled.reason);
            for (const item of group.항목들) {
              logsToWrite.push({
                발송일시: now,
                구분: category,
                고객: item.고객명,
                수신번호: item.수신번호,
                메시지내용: item.내용,
                메시지ID: '',
                문자유형: group.문자유형,
                결과코드: '통신오류',
                결과메시지: errMsg,
                테스트모드: 'N',
              });
            }
          }
        });
        this.db.insertSmsLogs(logsToWrite);
      }

      const anySuccess = successCount > 0;
      return {
        success: anySuccess,
        message: anySuccess
          ? `메세지미 접수: SMS ${smsSuccess}건, LMS ${lmsSuccess}건, 실패 ${failCount}건`
          : `메세지미 발송 실패: 요청 SMS ${smsRequested}건, LMS ${lmsRequested}건. 문자발송내역을 확인해 주세요`,
        data: {
          요청건수: items.length,
          SMS요청건수: smsRequested,
          LMS요청건수: lmsRequested,
          성공건수: successCount,
          실패건수: failCount,
          SMS성공건수: smsSuccess,
          LMS성공건수: lmsSuccess,
          테스트모드: false,
        },
      };
    } catch (err) {
      this.logEntries(category, items, '', 'AUTO', '통신오류', err.message, cfg.테스트모드);
      return { success: false, message: SmsService.formatUserError(err) };
    }
  }

  buildClientPhoneMap() {
    const map = {};
    for (const c of this.db.getAllClients()) {
      const name = String(c.이름 || '');
      if (map[name] == null) map[name] = c.연락처 || '';
    }
    return map;
  }

  scheduleTemplateValues(schedule, cfg) {
    return {
      기관명: cfg.기관명,
      고객명: schedule.고객 || '',
      날짜: schedule.날짜 || '',
      요일: koreanWeekday(schedule.날짜),
      시작시간: schedule.시작시간 || '',
      종료시간: schedule.종료시간 || '',
      치료사: schedule.치료사 || '',
      담당자: schedule.치료사 || '',
      서비스: schedule.서비스 || '',
    };
  }

  markScheduleSmsFlag(scheduleId, field, shouldNotify = true) {
    try {
      const row = this.db.getScheduleById(scheduleId);
      if (!row) return '없음';
      row[field] = true;
      this.db.upsertSchedule(row);
      if (shouldNotify && this.onDataChanged) {
        try { this.onDataChanged({ method: '자동문자발송', scopes: ['bootstrap'] }); } catch (_) {}
      }
      return '완료';
    } catch (_) {
      return '실패';
    }
  }

  async runAutoSms(nowMs = Date.now()) {
    if (this._autoRunning) return { ran: false, reason: 'already_running' };
    const allProps = this.db.getAllProperties();
    if (allProps.AUTO_SMS_ENABLED !== 'Y') return { ran: false, reason: 'disabled' };
    const cfg = this.getConfig(allProps);
    if (!cfg.apiKey || !cfg.sender) return { ran: false, reason: 'unconfigured' };

    this._autoRunning = true;
    let sentReminders = 0;
    let sentThanks = 0;
    try {
      const schedules = this.db.getAllSchedules();
      const phoneMap = this.buildClientPhoneMap();
      const todayStr = kstDateFromMs(nowMs);
      const tomorrowStr = kstDateFromMs(nowMs + 24 * 60 * 60 * 1000);

      for (const s of schedules) {
        const status = String(s.상태 || '').trim();
        if (status === '취소' || status === '노쇼') continue;
        const id = String(s.일정ID || '');
        if (!id) continue;

        const dateStr = String(s.날짜 || '').substring(0, 10);
        const reminderCandidate =
          status === '예약' &&
          !isTruthyCheck(s['예약문자 발송확인']) &&
          (dateStr === todayStr || dateStr === tomorrowStr);

        const thanksDueKey = autoSmsPropKey('THANKS_DUE', id);
        const thanksDueMs = Number(allProps[thanksDueKey] || 0);
        const thanksCandidate =
          !!thanksDueMs &&
          isTruthyCheck(s.수납확인) &&
          !isTruthyCheck(s['관리자문자 발송확인']);

        if (!reminderCandidate && !thanksCandidate) continue;

        const startMs = parseKstDateTimeMs(s.날짜, s.시작시간);
        if (startMs == null) continue;

        if (reminderCandidate && nowMs >= startMs - 24 * 60 * 60 * 1000 && nowMs < startMs) {
          const retryKey = autoSmsPropKey('REMINDER_RETRY', id);
          const retryAt = Number(allProps[retryKey] || 0);
          if (!retryAt || nowMs >= retryAt) {
            const text = replaceTemplate(
              this.getAutoTemplateContent('template_auto_reminder', allProps),
              this.scheduleTemplateValues(s, cfg),
            );
            const res = await this.sendSingle('일정예약', s.고객 || '', phoneMap[String(s.고객 || '')] || '', text, cfg);
            if (res.success) {
              sentReminders += 1;
              const marked = this.markScheduleSmsFlag(id, '예약문자 발송확인');
              if (marked === '실패') {
                this.db.setProperty(retryKey, String(nowMs + 25 * 60 * 60 * 1000));
              } else if (retryAt) {
                this.db.deleteProperty(retryKey);
              }
            } else {
              this.db.setProperty(retryKey, String(nowMs + 30 * 60 * 1000));
            }
          }
        }

        if (thanksCandidate && nowMs >= startMs && nowMs >= thanksDueMs) {
          const text = replaceTemplate(
            this.getAutoTemplateContent('template_auto_thanks', allProps),
            this.scheduleTemplateValues(s, cfg),
          );
          const res = await this.sendSingle('이용감사', s.고객 || '', phoneMap[String(s.고객 || '')] || '', text, cfg);
          if (res.success) {
            sentThanks += 1;
            this.markScheduleSmsFlag(id, '관리자문자 발송확인');
            this.db.deleteProperty(thanksDueKey);
          } else {
            this.db.setProperty(thanksDueKey, String(nowMs + 30 * 60 * 1000));
          }
        }
      }
      return { ran: true, sentReminders, sentThanks };
    } finally {
      this._autoRunning = false;
    }
  }
}

module.exports = { SmsService, templatePropKey, autoSmsPropKey };
