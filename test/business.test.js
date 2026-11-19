import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalDatabase } from '../src/db.js';
import { SmsService } from '../src/sms.js';
import { TherapyAppService } from '../src/business.js';
import { LocalHttpServer } from '../src/server.js';

function createFixture(fetchImpl) {
  const db = new LocalDatabase(':memory:');
  const sms = new SmsService(db, { fetchImpl: fetchImpl || (async () => { throw new Error('unexpected fetch'); }), retryDelayMs: 5 });
  const service = new TherapyAppService(db, sms);
  return { db, sms, service };
}

describe('TherapyAppService - 인증 및 마스터/일정/차팅/오프 RPC', () => {
  it('메인 접속 및 관리자 로그인/비밀번호 변경 시 기존 토큰이 무효화되고 새 토큰이 유효해야 한다', async () => {
    const { service, db } = createFixture();
    try {
      expect((await service.dispatch('앱접속로그인', { 비밀번호: 'wrong' })).success).toBe(false);
      expect((await service.dispatch('앱접속로그인', { 비밀번호: '1234' })).success).toBe(true);

      const login = await service.dispatch('관리자로그인', { 비밀번호: '1234' });
      expect(login.success).toBe(true);
      const oldToken = login.data.토큰;

      expect((await service.dispatch('관리자확인', { 토큰: oldToken })).data.유효).toBe(true);

      const changed = await service.dispatch('관리자비밀번호변경', {
        토큰: oldToken,
        현재비밀번호: '1234',
        새비밀번호: '9876',
      });
      expect(changed.success).toBe(true);
      const newToken = changed.data.토큰;

      expect((await service.dispatch('관리자확인', { 토큰: oldToken })).data.유효).toBe(false);
      expect((await service.dispatch('관리자확인', { 토큰: newToken })).data.유효).toBe(true);
    } finally {
      db.close();
    }
  });

  it('고객/담당자/서비스/일정/차팅/오프 CRUD 및 이름 변경 연쇄 동기화가 정상 동작해야 한다', async () => {
    const { service, db } = createFixture();
    try {
      const c1 = await service.dispatch('고객저장', { 이름: '홍길동', 연락처: '010-1234-5678', 성별: '남' });
      expect(c1.success).toBe(true);
      const t1 = await service.dispatch('치료사저장', { 이름: '김민수', 직책: '물리치료' });
      expect(t1.success).toBe(true);
      const s1 = await service.dispatch('서비스저장', { 서비스명: '도수치료', '금액(원)': 90000, '소요시간(분)': 50 });
      expect(s1.success).toBe(true);

      // 오프 등록
      const off = await service.dispatch('오프저장', { 날짜: '2026-11-20', 치료사: '김민수', 시작시간: '12:00', 종료시간: '13:00', 비고: '점심' });
      expect(off.success).toBe(true);

      // 일정 등록
      const sch = await service.dispatch('일정저장', {
        날짜: '2026-11-20',
        시작시간: '10:00',
        종료시간: '10:50',
        치료사: '김민수',
        고객: '홍길동',
        서비스: '도수치료',
        상태: '예약',
      });
      expect(sch.success).toBe(true);
      const schId = sch.data.갱신.일정ID;

      // 차팅 자동저장은 상태를 예약으로 유지
      const autoChart = await service.dispatch('차팅저장', {
        일정ID: schId,
        '관리(시술)내용': '임시 작성 중',
        자동저장: true,
      });
      expect(autoChart.success).toBe(true);
      expect(autoChart.data.일정갱신.상태).toBe('예약');

      // 예약 상태에 차팅 있으면 삭제 시 확인필요 반환
      const delAsk = await service.dispatch('일정삭제', schId);
      expect(delAsk.success).toBe(false);
      expect(delAsk.확인필요).toBe(true);

      // 최종 차팅 저장은 상태를 완료로 변경
      const finalChart = await service.dispatch('차팅저장', {
        일정ID: schId,
        '관리(시술)내용': '도수치료 완료',
        결과평가: '호전',
        데스크기재: '수납 안내',
        대표님기재: '다음 주 재평가',
      });
      expect(finalChart.success).toBe(true);
      expect(finalChart.data.일정갱신.상태).toBe('완료');

      // 고객명 변경 -> 일정과 차팅 모두 연쇄 갱신
      const renamed = await service.dispatch('고객저장', {
        id: c1.data.갱신.ID,
        이름: '홍길동(개명)',
        연락처: '010-1234-5678',
      });
      expect(renamed.success).toBe(true);
      expect(renamed.data.이름변경.일정건수).toBe(1);
      expect(renamed.data.이름변경.차팅건수).toBe(1);

      // 담당자명 변경 -> 일정, 차팅, 오프 모두 연쇄 갱신
      const tRenamed = await service.dispatch('치료사저장', {
        id: t1.data.갱신.ID,
        이름: '김민수팀장',
        직책: '팀장',
      });
      expect(tRenamed.success).toBe(true);
      expect(tRenamed.data.이름변경.일정건수).toBe(1);
      expect(db.getAllOffs()[0].치료사).toBe('김민수팀장');

      // 연결 기록 있는 고객 삭제 차단
      expect((await service.dispatch('고객삭제', c1.data.갱신.ID)).success).toBe(false);

      // 드래그 이동 -> 연결 차팅 스냅샷도 동기화
      const moved = await service.dispatch('일정드래그변경', {
        id: schId,
        날짜: '2026-11-21',
        시작시간: '14:00',
        종료시간: '14:50',
      });
      expect(moved.success).toBe(true);
      expect(moved.data.차팅갱신.날짜).toBe('2026-11-21');

      // 드래그 복사
      const copied = await service.dispatch('일정드래그복사', { 원본ID: schId, 날짜: '2026-11-28' });
      expect(copied.success).toBe(true);
      expect(copied.data.갱신.상태).toBe('예약');
      expect(copied.data.갱신.일정ID).not.toBe(schId);
    } finally {
      db.close();
    }
  });

  it('PC 부팅 시 자동 실행 및 원내 공유 로컬 설정이 저장·조회되고 콜백에 전달된다', async () => {
    const db = new LocalDatabase(':memory:');
    const sms = new SmsService(db);
    let captured = null;
    const service = new TherapyAppService(db, sms, {
      onConfigChanged: (cfg) => { captured = cfg; },
    });
    try {
      const token = (await service.dispatch('관리자로그인', { 비밀번호: '1234' })).data.토큰;
      const before = await service.dispatch('로컬상태조회', { 토큰: token });
      expect(before.success).toBe(true);
      expect(before.data.부팅자동실행).toBe(false);
      expect(before.data.자동실행트레이시작).toBe(true);

      const saved = await service.dispatch('로컬설정저장', {
        토큰: token,
        부팅자동실행: true,
        자동실행트레이시작: true,
        트레이상주: true,
        원내공유활성: true,
      });
      expect(saved.success).toBe(true);
      expect(saved.data.부팅자동실행).toBe(true);
      expect(captured).toEqual({
        lanEnabled: true,
        trayOnClose: true,
        autoStartEnabled: true,
        autoStartHidden: true,
      });

      const after = await service.dispatch('로컬상태조회', { 토큰: token });
      expect(after.data.부팅자동실행).toBe(true);
      expect(after.data.원내공유활성).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('SmsService & 우클릭 문자 발송 - 로컬 직접 발송 / 403 IP 미등록 / 타임아웃 / 자동문자', () => {
  it('우클릭 차팅 문자 발송이 실제 모드에서 메세지미 응답 100을 받으면 성공하고 예약문자 발송확인을 체크한다', async () => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url, body: init.body });
      return new Response(JSON.stringify({ result: '100', msg_type: 'SMS', message: '성공' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const { service, db } = createFixture(mockFetch);
    try {
      const token = (await service.dispatch('관리자로그인', { 비밀번호: '1234' })).data.토큰;
      await service.dispatch('메시지미설정저장', {
        토큰: token,
        apiKey: 'TEST_KEY',
        sender: '033-123-4567',
        기관명: '원탑통증재활센터',
        테스트모드: 'N',
      });
      await service.dispatch('고객저장', { 이름: '이영희', 연락처: '010-9999-8888' });
      await service.dispatch('치료사저장', { 이름: '박서연' });
      const sch = await service.dispatch('일정저장', {
        날짜: '2026-11-25',
        시작시간: '11:00',
        종료시간: '11:50',
        치료사: '박서연',
        고객: '이영희',
        서비스: '도수',
        상태: '예약',
      });

      const sendRes = await service.dispatch('메시지미차팅문자발송', {
        토큰: token,
        일정ID: sch.data.갱신.일정ID,
        문구: '[{기관명}] {고객명}님 {날짜}({요일}) {시작시간} 예약 안내',
      });
      expect(sendRes.success).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe('http://221.139.14.136/APIV2/API/sms_send');
      expect(calls[0].body).toContain('dstaddr=01099998888');
      expect(sendRes.data.갱신['예약문자 발송확인']).toBe(true);

      const logs = await service.dispatch('메시지미발송내역조회', { 토큰: token });
      expect(logs.data.length).toBe(1);
      expect(logs.data[0].결과코드).toBe('100');
      expect(logs.data[0].구분).toBe('차팅문자');
    } finally {
      db.close();
    }
  });

  it('메세지미에서 HTTP 403 (HTML 응답 포함)이 오면 IP 사전등록 안내 메시지를 명확히 돌려준다', async () => {
    const mockFetch = async () => new Response('<html><body>403 Forbidden</body></html>', { status: 403 });
    const { service, db } = createFixture(mockFetch);
    try {
      const token = (await service.dispatch('관리자로그인', { 비밀번호: '1234' })).data.토큰;
      await service.dispatch('메시지미설정저장', {
        토큰: token,
        apiKey: 'TEST_KEY',
        sender: '033-123-4567',
        기관명: '원탑통증재활센터',
        테스트모드: 'N',
      });
      await service.dispatch('고객저장', { 이름: '이영희', 연락처: '010-9999-8888' });
      const sch = await service.dispatch('일정저장', {
        날짜: '2026-11-25',
        시작시간: '11:00',
        종료시간: '11:50',
        치료사: '박서연',
        고객: '이영희',
        서비스: '도수',
        상태: '예약',
      });

      const sendRes = await service.dispatch('메시지미차팅문자발송', {
        토큰: token,
        일정ID: sch.data.갱신.일정ID,
        문구: '안내 문자',
      });
      expect(sendRes.success).toBe(false);
      expect(sendRes.message).toContain('403');
      expect(sendRes.message).toContain('공인 IP');
    } finally {
      db.close();
    }
  });

  it('연결 실패는 1회 재시도하고 타임아웃은 중복 발송 방지를 위해 재시도하지 않는다', async () => {
    let attempts = 0;
    const mockConnectThenOk = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connect ECONNREFUSED 221.139.14.136:80');
      return new Response(JSON.stringify({ result: '100', msg_type: 'SMS' }), { status: 200 });
    };
    const f1 = createFixture(mockConnectThenOk);
    try {
      const token = (await f1.service.dispatch('관리자로그인', { 비밀번호: '1234' })).data.토큰;
      await f1.service.dispatch('메시지미설정저장', { 토큰: token, apiKey: 'K', sender: '0331234567', 테스트모드: 'N' });
      const res = await f1.sms.sendSingle('테스트', '홍길동', '010-1111-2222', '안녕');
      expect(res.success).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      f1.db.close();
    }

    let timeoutAttempts = 0;
    const mockTimeout = async () => {
      timeoutAttempts += 1;
      const err = new Error('The operation timed out');
      err.name = 'TimeoutError';
      throw err;
    };
    const f2 = createFixture(mockTimeout);
    try {
      const token = (await f2.service.dispatch('관리자로그인', { 비밀번호: '1234' })).data.토큰;
      await f2.service.dispatch('메시지미설정저장', { 토큰: token, apiKey: 'K', sender: '0331234567', 테스트모드: 'N' });
      const res = await f2.sms.sendSingle('테스트', '홍길동', '010-1111-2222', '안녕');
      expect(res.success).toBe(false);
      expect(timeoutAttempts).toBe(1);
      expect(res.message).toContain('문자 서버 응답이 늦어');
    } finally {
      f2.db.close();
    }
  });

  it('자동문자 스케줄러가 24시간 전 재확인 문자를 중복 없이 1회 발송한다', async () => {
    const { service, sms, db } = createFixture();
    try {
      const token = (await service.dispatch('관리자로그인', { 비밀번호: '1234' })).data.토큰;
      await service.dispatch('메시지미설정저장', { 토큰: token, apiKey: 'K', sender: '0331234567', 테스트모드: 'Y' });
      await service.dispatch('자동문자트리거설치', { 토큰: token });
      await service.dispatch('고객저장', { 이름: '김고객', 연락처: '010-5555-6666' });
      await service.dispatch('일정저장', {
        날짜: '2026-11-20',
        시작시간: '10:00',
        종료시간: '10:50',
        치료사: '담당A',
        고객: '김고객',
        서비스: '도수',
        상태: '예약',
      });

      // KST 2026-11-19 15:00 = 19 hours before 2026-11-20 10:00
      const nowMs = Date.UTC(2026, 10, 19, 6, 0, 0); // UTC 06:00 = KST 15:00
      const r1 = await sms.runAutoSms(nowMs);
      expect(r1.sentReminders).toBe(1);

      const r2 = await sms.runAutoSms(nowMs + 60_000);
      expect(r2.sentReminders).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('LocalHttpServer E2E', () => {
  let tmpDir;
  let db;
  let server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'therapy-local-http-'));
    db = new LocalDatabase(path.join(tmpDir, 'test.sqlite'));
    const sms = new SmsService(db);
    const service = new TherapyAppService(db, sms);
    server = new LocalHttpServer(service, db, { port: 0, lanEnabled: false });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('정적 HTML/브릿지 서빙, RPC 헤더 검증, 부트스트랩 조회, 엑셀 내보내기 엔드포인트가 정상 작동한다', async () => {
    const base = `http://127.0.0.1:${server.port}`;

    const html = await fetch(`${base}/`).then((r) => r.text());
    expect(html).toContain('<script src="/bridge.js"></script>');
    expect(html).toContain('원탑통증재활센터');

    const bridge = await fetch(`${base}/bridge.js`).then((r) => r.text());
    expect(bridge).toContain('window.데이터관리모달');

    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    expect(health.ok).toBe(true);

    // X-Local-App 헤더 없으면 403
    const forbidden = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'getBootstrapData' }),
    });
    expect(forbidden.status).toBe(403);

    // 정상 RPC 호출
    const boot = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Local-App': '1' },
      body: JSON.stringify({ method: 'getBootstrapData' }),
    }).then((r) => r.json());
    expect(boot.success).toBe(true);
    expect(Array.isArray(boot.data.고객)).toBe(true);

    // 관리자 로그인 후 엑셀 내보내기
    const login = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Local-App': '1' },
      body: JSON.stringify({ method: '관리자로그인', arg: { 비밀번호: '1234' } }),
    }).then((r) => r.json());

    const exp = await fetch(`${base}/api/export-xlsx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Local-App': '1' },
      body: JSON.stringify({ 토큰: login.data.토큰 }),
    });
    expect(exp.status).toBe(200);
    const arr = new Uint8Array(await exp.arrayBuffer());
    // XLSX is a ZIP archive starting with PK (0x50, 0x4B)
    expect(arr[0]).toBe(0x50);
    expect(arr[1]).toBe(0x4b);
  });

  it('실시간 동기화 SSE(/api/events)와 /api/sync-version이 다른 기기의 변경 사항을 즉시 브로드캐스트한다', async () => {
    const base = `http://127.0.0.1:${server.port}`;

    const v1 = await fetch(`${base}/api/sync-version`).then((r) => r.json());
    expect(v1.success).toBe(true);
    expect(v1.version).toBe(1);

    const ac = new AbortController();
    const sseRes = await fetch(`${base}/api/events`, { signal: ac.signal });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    async function readUntil(marker) {
      const deadline = Date.now() + 5000;
      while (!buffer.includes(marker)) {
        if (Date.now() > deadline) throw new Error('SSE timeout waiting for ' + marker + '; got: ' + buffer);
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    }

    await readUntil('event: hello');
    expect(buffer).toContain('"version":1');

    // 핸드폰(phone-client)에서 고객 저장 RPC 실행
    const saveRes = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Local-App': '1',
        'X-Client-Id': 'phone-client',
      },
      body: JSON.stringify({ method: '고객저장', arg: { 이름: '모바일등록고객', 연락처: '010-7777-1234' } }),
    }).then((r) => r.json());
    expect(saveRes.success).toBe(true);

    await readUntil('event: data-changed');
    expect(buffer).toContain('"version":2');
    expect(buffer).toContain('"method":"고객저장"');
    expect(buffer).toContain('"originClientId":"phone-client"');

    const v2 = await fetch(`${base}/api/sync-version`).then((r) => r.json());
    expect(v2.version).toBe(2);

    ac.abort();
    await reader.cancel().catch(() => {});
  });
});
