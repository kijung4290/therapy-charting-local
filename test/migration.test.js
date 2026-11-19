import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalDatabase } from '../src/db.js';
import { SmsService } from '../src/sms.js';
import { TherapyAppService } from '../src/business.js';
import {
  parseWorkbookBuffer,
  summarizeParsedWorkbook,
  importParsedWorkbook,
  exportWorkbookBuffer,
} from '../src/migration.js';

function buildGoogleSheetsSampleWorkbook() {
  const wb = XLSX.utils.book_new();

  // 1. 고객명단 (including Excel numeric stripped phone number & serial date)
  const wsClients = XLSX.utils.aoa_to_sheet([
    ['ID', '등록일시', '이름', '생년월일', '성별', '연락처', '주소', '특이사항', '비고'],
    ['c001', '2026-10-01 09:00:00', '김영희', 29292, '여', 1022220001, '서울시 강남구 테스트로 1', '허리 통증', 'VIP'],
    ['c002', '2026-10-02 10:30:00', '이철수', '1975-05-15', '남', '010-3333-4444', '서울시 서초구 테스트로 2', '', ''],
  ]);
  XLSX.utils.book_append_sheet(wb, wsClients, '고객명단');

  // 2. 치료사
  const wsTherapists = XLSX.utils.aoa_to_sheet([
    ['ID', '등록일시', '이름', '직책', '연락처', '비고'],
    ['t001', '2026-10-01 08:00:00', '김민수', '원장', '010-1111-1001', '도수 전문'],
  ]);
  XLSX.utils.book_append_sheet(wb, wsTherapists, '치료사');

  // 3. 서비스목록
  const wsServices = XLSX.utils.aoa_to_sheet([
    ['ID', '등록일시', '서비스명', '금액(원)', '소요시간(분)', '비고'],
    ['sv01', '2026-10-01 08:00:00', '90000', 90000, 50, '도수 치료'],
  ]);
  XLSX.utils.book_append_sheet(wb, wsServices, '서비스목록');

  // 4. 일정 (including Excel serial date 46345 = 2026-11-19 and fractional times 0.375 = 09:00, 0.4097222... = 09:50)
  const wsSchedules = XLSX.utils.aoa_to_sheet([
    ['일정ID', '날짜', '시작시간', '종료시간', '치료사', '고객', '서비스', '상태', '비고', '등록일시', '방문확인', '관리확인', '수납확인', '예약문자 발송확인', '관리자문자 발송확인'],
    ['sc01', 46345, 0.375, 590 / 1440, '김민수', '김영희', '90000', '완료', '첫 세션', '2026-11-18 12:00:00', true, true, true, true, false],
    ['sc02', '2026-11-20', '오후 2:30', '오후 3:20', '김민수', '이철수', '90000', '예약', '', '2026-11-18 14:00:00', '', '', '', '', ''],
  ]);
  XLSX.utils.book_append_sheet(wb, wsSchedules, '일정');

  // 5. 차팅
  const wsCharts = XLSX.utils.aoa_to_sheet([
    ['차팅ID', '일정ID', '날짜', '치료사', '고객', '서비스', '관리(시술)내용', '결과평가', '데스크기재', '대표님기재', '작성일시'],
    ['ch01', 'sc01', '2026-11-19', '김민수', '김영희', '90000', '요추 가동술', '통증 감소', '다음 주 예약 희망', '경과 양호', '2026-11-19 10:00:00'],
  ]);
  XLSX.utils.book_append_sheet(wb, wsCharts, '차팅');

  // 6. 문자발송내역
  const wsSms = XLSX.utils.aoa_to_sheet([
    ['발송일시', '구분', '고객', '수신번호', '메시지내용', '메시지ID', '문자유형', '결과코드', '결과메시지', '테스트모드'],
    ['2026-11-18 15:00:00', '일정예약', '김영희', '01022220001', '내일 예약 안내', '', 'SMS', '100', '발송 요청 접수 완료', 'N'],
  ]);
  XLSX.utils.book_append_sheet(wb, wsSms, '문자발송내역');

  // 7. 설정
  const wsSettings = XLSX.utils.aoa_to_sheet([
    ['키', '값'],
    ['메인접속비밀번호', '5678'],
    ['관리자비밀번호', '9999'],
  ]);
  XLSX.utils.book_append_sheet(wb, wsSettings, '설정');

  // 8. 오프
  const wsOffs = XLSX.utils.aoa_to_sheet([
    ['오프ID', '날짜', '치료사', '시작시간', '종료시간', '비고', '등록일시'],
    ['of01', '2026-11-21', '김민수', '12:00', '13:00', '점심시간', '2026-11-18 09:00:00'],
  ]);
  XLSX.utils.book_append_sheet(wb, wsOffs, '오프');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('스프레드시트 업로드 데이터 이전 및 내보내기', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'therapy-local-mig-'));
    db = new LocalDatabase(path.join(tmpDir, 'data.sqlite'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('현재 8개 시트 구조 엑셀을 파싱/미리보기/이전하면 날짜·시간·전화번호·체크박스·설정이 정확히 반영되고 자동 백업이 생성된다', () => {
    const buf = buildGoogleSheetsSampleWorkbook();
    const parsed = parseWorkbookBuffer(buf, '원탑_백업.xlsx');
    const summary = summarizeParsedWorkbook(parsed);

    expect(summary.감지시트).toEqual(['고객명단', '치료사', '서비스목록', '일정', '차팅', '문자발송내역', '설정', '오프']);
    expect(summary.건수.고객명단).toBe(2);
    expect(summary.건수.일정).toBe(2);
    expect(summary.건수.오프).toBe(1);

    const res = importParsedWorkbook(db, parsed, { 모드: 'replace', 설정포함: true });
    expect(res.success).toBe(true);
    expect(res.data.백업파일).toContain('before_import');
    expect(db.listBackups().length).toBeGreaterThanOrEqual(1);

    const clients = db.getAllClients();
    expect(clients[0].이름).toBe('김영희');
    expect(clients[0].연락처).toBe('01022220001'); // Excel에서 0 빠진 번호 자동 복구
    expect(clients[0].생년월일).toBe('1980-03-12'); // Excel serial 29292

    const schedules = db.getAllSchedules();
    expect(schedules[0].날짜).toBe('2026-11-19'); // Excel serial 46345
    expect(schedules[0].시작시간).toBe('09:00');
    expect(schedules[0].종료시간).toBe('09:50');
    expect(schedules[0].방문확인).toBe(true);
    expect(schedules[0]['관리자문자 발송확인']).toBe(false);
    expect(schedules[1].시작시간).toBe('14:30'); // 오후 2:30 변환
    expect(schedules[1].종료시간).toBe('15:20');

    expect(db.getAllCharts()[0]['관리(시술)내용']).toBe('요추 가동술');
    expect(db.getAllOffs()[0].비고).toBe('점심시간');
    expect(db.getSetting('메인접속비밀번호')).toBe('5678');
    expect(db.getSetting('관리자비밀번호')).toBe('9999');

    // 내보내기 -> 재파싱 라운드트립 검증
    const exportedBuf = exportWorkbookBuffer(db);
    const reParsed = parseWorkbookBuffer(exportedBuf, 'roundtrip.xlsx');
    expect(reParsed.데이터.고객명단.length).toBe(2);
    expect(reParsed.데이터.일정.length).toBe(2);
    expect(reParsed.데이터.일정[0].시작시간).toBe('09:00');
    expect(reParsed.데이터.차팅[0].데스크기재).toBe('다음 주 예약 희망');
    expect(reParsed.데이터.문자발송내역.length).toBe(1);
    expect(reParsed.데이터.오프.length).toBe(1);
  });

  it('구버전 시트명(대상자명단)과 구버전 컬럼(대상자·치료내용·데스크 기재·고객명단 J/K열)도 자동 매핑한다', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['ID', '등록일시', '이름', '생년월일', '성별', '연락처', '주소', '특이사항', '비고', '수납확인', '예약문자 발송확인'],
      ['old1', '2025-01-01', '박구버전', '', '', '010-7777-8888', '', '', '', true, true],
    ]), '대상자명단');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['일정ID', '날짜', '시작시간', '종료시간', '치료사', '대상자', '서비스', '상태', '비고', '등록일시', '방문', '상담확인'],
      ['olds1', '2025-02-01', '10:00', '10:50', '원장', '박구버전', '도수', '완료', '', '', '확인', '완료'],
    ]), '일정');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['차팅ID', '일정ID', '날짜', '치료사', '대상자', '서비스', '치료내용', '결과평가', '데스크 기재', '대표님 기재', '작성일시'],
      ['oldc1', 'olds1', '2025-02-01', '원장', '박구버전', '도수', '기존 치료내용', '양호', '데스크 메모', '대표 메모', '2025-02-01 11:00:00'],
    ]), '차팅');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const parsed = parseWorkbookBuffer(buf, 'legacy.xlsx');
    const res = importParsedWorkbook(db, parsed, { 모드: 'replace', 설정포함: false });
    expect(res.success).toBe(true);

    expect(db.getAllClients()[0].이름).toBe('박구버전');
    const sch = db.getAllSchedules()[0];
    expect(sch.고객).toBe('박구버전');
    expect(sch.방문확인).toBe(true);
    expect(sch.관리확인).toBe(true);
    expect(sch.수납확인).toBe(true); // 고객명단 J열 이전
    expect(sch['예약문자 발송확인']).toBe(true); // 고객명단 K열 이전

    const ch = db.getAllCharts()[0];
    expect(ch.고객).toBe('박구버전');
    expect(ch['관리(시술)내용']).toBe('기존 치료내용');
    expect(ch.데스크기재).toBe('데스크 메모');
    expect(ch.대표님기재).toBe('대표 메모');
  });

  it('RPC로 비밀번호 포함 스프레드시트를 업로드하면 새 관리자 토큰을 돌려주어 로그인이 유지된다', async () => {
    const sms = new SmsService(db);
    const service = new TherapyAppService(db, sms);
    const oldToken = (await service.dispatch('관리자로그인', { 비밀번호: '1234' })).data.토큰;
    const b64 = buildGoogleSheetsSampleWorkbook().toString('base64');

    const preview = await service.dispatch('스프레드시트미리보기', {
      토큰: oldToken,
      파일명: 'test.xlsx',
      파일Base64: b64,
    });
    expect(preview.success).toBe(true);
    expect(preview.data.총건수).toBe(11);

    const imported = await service.dispatch('스프레드시트가져오기', {
      토큰: oldToken,
      파일명: 'test.xlsx',
      파일Base64: b64,
      모드: 'replace',
      설정포함: true,
    });
    expect(imported.success).toBe(true);
    expect(imported.data.새토큰).toBeTruthy();

    // 새 토큰은 유효하고, 변경된 새 비밀번호(9999)로 로그인 가능
    expect((await service.dispatch('관리자확인', { 토큰: imported.data.새토큰 })).data.유효).toBe(true);
    expect((await service.dispatch('관리자로그인', { 비밀번호: '9999' })).success).toBe(true);
  });

  it('병합(merge) 모드는 기존 로컬 행을 유지하면서 신규 행을 추가하고 중복 문자 로그는 건너뛴다', () => {
    db.upsertClient({ ID: 'local1', 등록일시: '2026-11-01', 이름: '기존로컬고객', 생년월일: '', 성별: '', 연락처: '010-0000-0000', 주소: '', 특이사항: '', 비고: '' });
    const buf = buildGoogleSheetsSampleWorkbook();
    const parsed = parseWorkbookBuffer(buf, 'merge.xlsx');

    const r1 = importParsedWorkbook(db, parsed, { 모드: 'merge', 설정포함: false });
    expect(r1.success).toBe(true);
    expect(db.getAllClients().length).toBe(3); // 기존 1 + 신규 2
    expect(db.getSetting('관리자비밀번호')).toBe('1234'); // 설정포함 false이므로 기존 유지

    // 동일 파일 재병합 시 문자발송내역 중복 삽입 방지
    const r2 = importParsedWorkbook(db, parsed, { 모드: 'merge', 설정포함: false });
    expect(r2.success).toBe(true);
    expect(r2.data.건수.문자발송내역).toBe(0);
    expect(db.getAllSmsLogsAsc().length).toBe(1);
  });
});
