'use strict';

const crypto = require('node:crypto');

const APP_CONFIG = {
  제목: '원탑통증재활센터',
  시간대: 'Asia/Seoul',
  메인접속비밀번호: '1234',
  관리자비밀번호: '1234',
};

const SHEET_DEFS = [
  { 이름: '고객명단', 헤더: ['ID', '등록일시', '이름', '생년월일', '성별', '연락처', '주소', '특이사항', '비고'] },
  { 이름: '치료사', 헤더: ['ID', '등록일시', '이름', '직책', '연락처', '비고'] },
  { 이름: '서비스목록', 헤더: ['ID', '등록일시', '서비스명', '금액(원)', '소요시간(분)', '비고'] },
  { 이름: '일정', 헤더: ['일정ID', '날짜', '시작시간', '종료시간', '치료사', '고객', '서비스', '상태', '비고', '등록일시', '방문확인', '관리확인', '수납확인', '예약문자 발송확인', '관리자문자 발송확인'] },
  { 이름: '차팅', 헤더: ['차팅ID', '일정ID', '날짜', '치료사', '고객', '서비스', '관리(시술)내용', '결과평가', '데스크기재', '대표님기재', '작성일시'] },
  { 이름: '문자발송내역', 헤더: ['발송일시', '구분', '고객', '수신번호', '메시지내용', '메시지ID', '문자유형', '결과코드', '결과메시지', '테스트모드'] },
  { 이름: '설정', 헤더: ['키', '값'] },
  { 이름: '오프', 헤더: ['오프ID', '날짜', '치료사', '시작시간', '종료시간', '비고', '등록일시'] },
];

const REQUIRED_FIELDS = {
  고객명단: '이름',
  치료사: '이름',
  서비스목록: '서비스명',
};

const DEFAULT_SMS_API_URL = 'http://221.139.14.136/APIV2/API';

const DEFAULT_SMS_CONFIG = {
  기관명: '치료센터',
  테스트모드: 'Y',
  신규고객문구: '[{기관명}]\n{고객명}님, 고객 등록이 완료되었습니다. 이용해 주셔서 감사합니다.',
  일정안내문구: '[{기관명}]\n{고객명}님, {날짜}({요일}) {시작시간} {서비스} 일정이 예약되었습니다.\n담당: {담당자}',
  예약재확인문구: '[{기관명}]\n{고객명}님, 내일 {날짜}({요일}) {시작시간} {서비스} 일정이 예정되어 있습니다.\n담당: {담당자}',
  이용감사문구: '[{기관명}]\n{고객명}님, 오늘 이용해 주셔서 감사합니다.\n더 나은 서비스로 보답하겠습니다.',
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function kstParts(date) {
  const ms = (date instanceof Date ? date.getTime() : Number(date)) || Date.now();
  const d = new Date(ms + KST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    dd: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    ss: d.getUTCSeconds(),
  };
}

function kstTimestamp(date) {
  const p = kstParts(date || new Date());
  return `${p.y}-${pad2(p.m)}-${pad2(p.dd)} ${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}`;
}

function kstToday(date) {
  const p = kstParts(date || new Date());
  return `${p.y}-${pad2(p.m)}-${pad2(p.dd)}`;
}

function kstDateFromMs(ms) {
  const p = kstParts(ms);
  return `${p.y}-${pad2(p.m)}-${pad2(p.dd)}`;
}

function newId() {
  return crypto.randomUUID().substring(0, 8);
}

function fullUuid() {
  return crypto.randomUUID();
}

function cleanPhone(phone) {
  return String(phone == null ? '' : phone).replace(/[^0-9]/g, '');
}

function isValidPhone(phone) {
  return /^[0-9]{9,11}$/.test(cleanPhone(phone));
}

function cleanSmsContent(content) {
  return String(content == null ? '' : content).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '?');
}

function smsBytes(content) {
  let total = 0;
  const str = String(content == null ? '' : content);
  for (let i = 0; i < str.length; i++) {
    total += str.charCodeAt(i) <= 0x7f ? 1 : 2;
  }
  return total;
}

function replaceTemplate(template, values) {
  return cleanSmsContent(
    String(template == null ? '' : template).replace(/\{([^{}]+)\}/g, (full, key) => {
      return values[key] == null ? full : String(values[key]);
    }),
  );
}

function koreanWeekday(dateStr) {
  const parts = String(dateStr || '').substring(0, 10).split('-');
  if (parts.length !== 3) return '';
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return '';
  return ['일', '월', '화', '수', '목', '금', '토'][dt.getUTCDay()];
}

function parseKstDateTimeMs(dateStr, timeStr) {
  const d = String(dateStr || '').substring(0, 10);
  const t = String(timeStr || '').substring(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(t)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const utcMs = Date.UTC(y, m - 1, dd, hh, mm, 0) - KST_OFFSET_MS;
  return Number.isNaN(utcMs) ? null : utcMs;
}

function isTruthyCheck(val) {
  if (val === true || val === 1) return true;
  const s = String(val == null ? '' : val).trim().toLowerCase();
  return ['true', '1', 'y', 'yes', '확인', '완료', '수납완료', '방문완료', '관리완료', '발송', '발송완료', 'o', 'v'].includes(s);
}

function isValidScheduleStatus(status) {
  return ['예약', '완료', '예약완료', '노쇼', '취소'].includes(String(status || '').trim());
}

function hmacSha256Base64Url(input, secret) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(String(input), 'utf8')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function normalizeCheckStorage(val) {
  if (val === '' || val == null) return '';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  const s = String(val).trim().toLowerCase();
  if (!s) return '';
  if (s === 'false' || s === '0' || s === 'n' || s === 'no') return 'false';
  return isTruthyCheck(val) ? 'true' : '';
}

function deserializeCheckValue(val) {
  if (val === true || val === 'true') return true;
  if (val === false || val === 'false') return false;
  return '';
}

module.exports = {
  APP_CONFIG,
  SHEET_DEFS,
  REQUIRED_FIELDS,
  DEFAULT_SMS_API_URL,
  DEFAULT_SMS_CONFIG,
  KST_OFFSET_MS,
  pad2,
  kstTimestamp,
  kstToday,
  kstDateFromMs,
  newId,
  fullUuid,
  cleanPhone,
  isValidPhone,
  cleanSmsContent,
  smsBytes,
  replaceTemplate,
  koreanWeekday,
  parseKstDateTimeMs,
  isTruthyCheck,
  isValidScheduleStatus,
  hmacSha256Base64Url,
  normalizeCheckStorage,
  deserializeCheckValue,
};
