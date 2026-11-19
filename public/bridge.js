(function () {
  'use strict';

  var CLIENT_ID = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);

  function rpcFetch(method, arg) {
    return fetch('/api/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Local-App': '1',
        'X-Client-Id': CLIENT_ID,
      },
      body: JSON.stringify({ method: method, arg: arg }),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          throw new Error((data && data.message) || ('HTTP ' + res.status));
        }
        return data;
      });
    });
  }

  function createRunner(successHandler, failureHandler) {
    return new Proxy({}, {
      get: function (_target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (fn) { return createRunner(fn, failureHandler); };
        }
        if (prop === 'withFailureHandler') {
          return function (fn) { return createRunner(successHandler, fn); };
        }
        if (typeof prop !== 'string') return undefined;
        return function (arg) {
          rpcFetch(prop, arg)
            .then(function (result) {
              if (typeof successHandler === 'function') successHandler(result);
            })
            .catch(function (err) {
              if (typeof failureHandler === 'function') {
                failureHandler(err instanceof Error ? err : new Error(String(err)));
              }
            });
        };
      },
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createRunner(null, null);

  // === 실시간 다중 기기 동기화 (SSE + 창 복귀/탭 전환 감지) ===
  var syncState = {
    version: null,
    bootId: '',
    connected: false,
    syncing: false,
    pendingCharts: false,
    pendingResync: false,
    timer: null,
    es: null,
  };

  function 동기화배지갱신() {
    var badge = document.getElementById('실시간동기화배지');
    if (!badge) return;
    if (syncState.connected) {
      badge.className = 'inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200';
      badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>실시간 동기화';
      badge.title = '다른 PC나 핸드폰에서 수정하면 화면이 자동으로 갱신됩니다';
    } else {
      badge.className = 'inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200';
      badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-gray-400"></span>재연결 중';
      badge.title = '로컬 서버와 실시간 동기화 연결을 다시 시도 중입니다';
    }
  }

  function 백그라운드동기화실행(차팅포함) {
    if (typeof window.상태 === 'undefined' || !window.상태.앱접속토큰) return;
    if (syncState.syncing) {
      syncState.pendingResync = true;
      if (차팅포함) syncState.pendingCharts = true;
      return;
    }
    syncState.syncing = true;
    var 차팅갱신필요 = !!(차팅포함 && window.상태.차팅로딩됨);

    var 작업 = [rpcFetch('getBootstrapData', undefined)];
    if (차팅갱신필요) 작업.push(rpcFetch('차팅데이터조회', undefined));

    Promise.all(작업)
      .then(function (결과들) {
        var boot = 결과들[0];
        if (boot && boot.success && boot.data) {
          window.상태.고객 = boot.data.고객 || [];
          window.상태.치료사 = boot.data.치료사 || [];
          window.상태.서비스 = boot.data.서비스 || [];
          window.상태.일정 = boot.data.일정 || [];
          window.상태.오프 = boot.data.오프 || [];
          window.상태.담당자순서 = Array.isArray(boot.data.담당자순서) ? boot.data.담당자순서 : [];
        }
        var charts = 결과들[1];
        if (charts && charts.success && Array.isArray(charts.data)) {
          window.상태.차팅 = charts.data;
          window.상태.차팅로딩됨 = true;
        }
        if (typeof window.render === 'function' && !document.getElementById('일정컨텍스트메뉴')) {
          window.render();
        }
      })
      .catch(function () {})
      .finally(function () {
        syncState.syncing = false;
        if (syncState.pendingResync) {
          var nextCharts = syncState.pendingCharts;
          syncState.pendingResync = false;
          syncState.pendingCharts = false;
          백그라운드동기화실행(nextCharts);
        }
      });
  }

  function 백그라운드동기화예약(차팅포함) {
    if (차팅포함) syncState.pendingCharts = true;
    if (syncState.timer) clearTimeout(syncState.timer);
    syncState.timer = setTimeout(function () {
      var needCharts = syncState.pendingCharts;
      syncState.timer = null;
      syncState.pendingCharts = false;
      백그라운드동기화실행(needCharts);
    }, 200);
  }

  function 서버버전확인후동기화(강제) {
    fetch('/api/sync-version', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (info) {
        if (!info || !info.success) return;
        var changed =
          syncState.version != null &&
          (info.version !== syncState.version || info.bootId !== syncState.bootId);
        syncState.version = info.version;
        syncState.bootId = info.bootId || '';
        if (changed || 강제) {
          백그라운드동기화예약(true);
        }
      })
      .catch(function () {});
  }

  function 실시간동기화시작() {
    if (typeof EventSource === 'undefined') {
      setInterval(function () {
        if (!document.hidden) 서버버전확인후동기화(false);
      }, 10000);
      return;
    }
    if (syncState.es) {
      try { syncState.es.close(); } catch (_) {}
    }
    var es = new EventSource('/api/events');
    syncState.es = es;

    es.addEventListener('hello', function (ev) {
      syncState.connected = true;
      동기화배지갱신();
      try {
        var data = JSON.parse(ev.data || '{}');
        var changed =
          syncState.version != null &&
          (data.version !== syncState.version || data.bootId !== syncState.bootId);
        syncState.version = data.version;
        syncState.bootId = data.bootId || '';
        if (changed) 백그라운드동기화예약(true);
      } catch (_) {}
    });

    es.addEventListener('data-changed', function (ev) {
      try {
        var data = JSON.parse(ev.data || '{}');
        syncState.version = data.version;
        if (data.bootId) syncState.bootId = data.bootId;
        if (data.originClientId && data.originClientId === CLIENT_ID) {
          return;
        }
        var scopes = Array.isArray(data.scopes) ? data.scopes : ['bootstrap'];
        백그라운드동기화예약(scopes.indexOf('charts') >= 0);
      } catch (_) {
        백그라운드동기화예약(true);
      }
    });

    es.onerror = function () {
      syncState.connected = false;
      동기화배지갱신();
    };

    // 모바일/절전 복귀 대비 15초 백업 체크 (연결이 끊겼을 때만 동작)
    setInterval(function () {
      if (!document.hidden && !syncState.connected) {
        서버버전확인후동기화(false);
      }
    }, 15000);
  }

  window.수동데이터새로고침 = function () {
    if (typeof window.새로고침데이터 !== 'function') return;
    window.새로고침데이터(function () {
      if (typeof window.render === 'function') window.render();
      if (typeof window.차팅데이터불러오기 === 'function' && window.상태 && window.상태.차팅로딩됨) {
        window.상태.차팅로딩됨 = false;
        window.차팅데이터불러오기(function () {
          if (typeof window.render === 'function') window.render();
        }, true);
      }
      서버버전확인후동기화(false);
      if (typeof window.showToast === 'function') {
        window.showToast('최신 데이터를 불러왔습니다', 'info');
      }
    });
  };

  window.addEventListener('DOMContentLoaded', function () {
    동기화배지갱신();
    실시간동기화시작();
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      서버버전확인후동기화(false);
    }
  });

  window.addEventListener('focus', function () {
    서버버전확인후동기화(false);
  });

  if (window.localDesktop && window.localDesktop.onWindowShown) {
    window.localDesktop.onWindowShown(function () {
      서버버전확인후동기화(true);
    });
  }

  // === 로컬 앱 전용 상태 ===
  window.로컬상태 = {
    정보: null,
    업로드파일명: '',
    업로드Base64: '',
    미리보기: null,
    이전모드: 'replace',
    설정포함: true,
    현재공인IP: '',
    업데이트: null,
    업데이트배너숨김: false,
  };

  function 업데이트배너렌더() {
    var el = document.getElementById('업데이트배너');
    if (!el) return;
    var u = window.로컬상태.업데이트;
    if (!u || window.로컬상태.업데이트배너숨김) {
      el.classList.add('hidden');
      return;
    }
    if (u.status === 'downloading') {
      el.className = 'bg-blue-600 text-white text-xs sm:text-sm px-4 py-2.5 shadow-sm';
      el.innerHTML =
        '<div class="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">' +
        '<div><i class="fa-solid fa-cloud-arrow-down mr-1.5"></i>새 버전 <strong>v' + esc(u.latestVersion || '') + '</strong> 다운로드 중... (' + Number(u.percent || 0) + '%)</div>' +
        '<div class="w-40 h-2 bg-white/30 rounded-full overflow-hidden"><div class="h-full bg-white transition-all" style="width:' + Number(u.percent || 0) + '%"></div></div>' +
        '</div>';
      el.classList.remove('hidden');
      return;
    }
    if (u.status === 'downloaded') {
      el.className = 'bg-indigo-600 text-white text-xs sm:text-sm px-4 py-2.5 shadow-sm';
      el.innerHTML =
        '<div class="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">' +
        '<div><i class="fa-solid fa-sparkles mr-1.5"></i>새 버전 <strong>v' + esc(u.latestVersion || '') + '</strong>이 준비되었습니다. (기존 데이터는 자동 백업 후 안전하게 유지됩니다)</div>' +
        '<div class="flex items-center gap-2">' +
        '<button type="button" onclick="업데이트설치하기()" class="bg-white text-indigo-700 hover:bg-indigo-50 font-bold text-xs px-3 py-1.5 rounded-lg shadow-xs"><i class="fa-solid fa-rotate mr-1"></i>지금 재시작하여 업데이트</button>' +
        '<button type="button" onclick="window.로컬상태.업데이트배너숨김=true;업데이트배너렌더()" class="text-white/80 hover:text-white text-xs px-2 py-1">나중에</button>' +
        '</div></div>';
      el.classList.remove('hidden');
      return;
    }
    el.classList.add('hidden');
  }
  window.업데이트배너렌더 = 업데이트배너렌더;

  function 업데이트상태반영(state) {
    if (!state) return;
    var prevStatus = window.로컬상태.업데이트 && window.로컬상태.업데이트.status;
    window.로컬상태.업데이트 = state;
    if (state.status === 'downloaded' && prevStatus !== 'downloaded') {
      window.로컬상태.업데이트배너숨김 = false;
    }
    업데이트배너렌더();
    var 상태박스 = document.getElementById('로컬업데이트상태영역');
    if (상태박스) {
      상태박스.innerHTML = 업데이트상태카드내부HTML();
    }
  }

  function 업데이트상태카드내부HTML() {
    var u = window.로컬상태.업데이트 || {};
    var 현재버전 = u.currentVersion || (window.로컬상태.정보 && window.로컬상태.정보.앱버전) || '1.0.0';
    var 배지 = '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-gray-100 text-gray-700">v' + esc(현재버전) + '</span>';
    if (u.status === 'downloaded') {
      배지 = '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-100 text-indigo-700">v' + esc(u.latestVersion || '') + ' 설치 준비 완료</span>';
    } else if (u.status === 'downloading') {
      배지 = '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-100 text-blue-700">다운로드 중 ' + Number(u.percent || 0) + '%</span>';
    } else if (u.status === 'checking') {
      배지 = '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-700">확인 중...</span>';
    }
    return '<div class="flex flex-wrap items-center justify-between gap-2">' +
      '<div>' +
      '<div class="flex items-center gap-2"><span class="text-sm font-bold text-gray-800">현재 버전 v' + esc(현재버전) + '</span>' + 배지 + '</div>' +
      '<p class="text-xs text-gray-500 mt-1">' + esc(u.message || 'GitHub Releases에서 30분마다 자동으로 새 버전을 확인합니다.') + (u.lastCheckedAt ? ' (최근 확인: ' + esc(u.lastCheckedAt) + ')' : '') + '</p>' +
      '</div>' +
      '<div class="flex items-center gap-2">' +
      (u.status === 'downloaded'
        ? '<button type="button" onclick="업데이트설치하기()" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3.5 py-2 rounded-lg"><i class="fa-solid fa-rotate mr-1"></i>재시작하여 업데이트</button>'
        : '<button type="button" onclick="업데이트확인하기()" ' + (u.status === 'checking' || u.status === 'downloading' ? 'disabled' : '') + ' class="bg-white hover:bg-gray-100 disabled:opacity-50 text-gray-700 border border-gray-300 text-xs font-semibold px-3 py-2 rounded-lg"><i class="fa-solid fa-arrows-rotate mr-1"></i>지금 업데이트 확인</button>') +
      '</div></div>';
  }

  window.업데이트확인하기 = function () {
    if (!window.localDesktop || !window.localDesktop.checkForUpdates) {
      showToast('설치된 데스크톱 앱에서 자동 업데이트를 확인할 수 있습니다', 'info');
      return;
    }
    window.localDesktop.checkForUpdates().then(function (res) {
      if (res && res.data) 업데이트상태반영(res.data);
      if (res && res.message) showToast(res.message, res.success ? 'info' : 'error');
    }).catch(function (err) {
      showToast('업데이트 확인 오류: ' + err.message, 'error');
    });
  };

  window.업데이트설치하기 = function () {
    if (!window.localDesktop || !window.localDesktop.installUpdate) return;
    if (!confirm('현재 데이터를 자동 백업한 뒤 새 버전으로 업데이트하고 프로그램을 재시작할까요?')) return;
    window.localDesktop.installUpdate().then(function (res) {
      if (res && res.message) showToast(res.message, res.success ? 'info' : 'error');
    });
  };

  if (window.localDesktop && window.localDesktop.onUpdateStatus) {
    window.localDesktop.onUpdateStatus(업데이트상태반영);
    window.addEventListener('DOMContentLoaded', function () {
      window.localDesktop.getUpdateStatus().then(업데이트상태반영).catch(function () {});
    });
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunkSize = 0x8000;
    var chunks = [];
    for (var i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(''));
  }

  function 바이트표시(bytes) {
    var n = Number(bytes || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  window.텍스트복사 = function (text, label) {
    if (!text) return;
    var done = function () { showToast((label || '내용') + '이(가) 복사되었습니다', 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        var el = document.createElement('textarea');
        el.value = text;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        done();
      });
    } else {
      var el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      done();
    }
  };

  window.현재공인IP확인 = function (자동여부) {
    var 표시 = $('현재공인IP영역');
    if (표시) {
      표시.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>현재 PC 공인 IP 확인 중...';
    }
    서버호출('현재공인IP조회', { 토큰: 상태.로그인토큰 }, function (data) {
      var ip = (data && data.ip) || '';
      window.로컬상태.현재공인IP = ip;
      var 영역 = $('현재공인IP영역');
      if (영역 && ip) {
        영역.innerHTML =
          '<span class="font-mono font-bold text-emerald-800 bg-white border border-emerald-200 px-2 py-0.5 rounded">' + esc(ip) + '</span>' +
          '<button type="button" onclick="텍스트복사(\'' + js문자(ip) + '\', \'공인 IP\')" class="ml-2 text-xs font-semibold text-emerald-700 hover:underline"><i class="fa-solid fa-copy mr-0.5"></i>IP 복사</button>';
      }
      if (!자동여부 && ip) showToast('현재 PC 공인 IP: ' + ip, 'info');
    }, function (err) {
      var 영역 = $('현재공인IP영역');
      if (영역) {
        영역.innerHTML = '<span class="text-red-600">' + esc((err && err.message) || 'IP 조회 실패') + '</span>';
      }
    }, { 조용히: !!자동여부 });
  };

  window.데이터관리모달 = function () {
    if (!상태.로그인토큰) {
      관리자로그인모달(null, function () {
        데이터관리모달();
      });
      return;
    }
    서버호출('로컬상태조회', { 토큰: 상태.로그인토큰 }, function (정보) {
      window.로컬상태.정보 = 정보;
      데이터관리모달렌더();
    }, function () {
      상태.로그인토큰 = '';
      sessionStorage.removeItem('치료차팅토큰');
      render();
      관리자로그인모달(null, function () {
        데이터관리모달();
      });
    });
  };

  window.데이터관리모달렌더 = function () {
    var 정보 = window.로컬상태.정보 || {};
    var 건수 = 정보.건수 || {};
    var 백업목록 = 정보.백업목록 || [];
    var 미리보기 = window.로컬상태.미리보기;
    var 데스크톱 = !!(window.localDesktop && window.localDesktop.isDesktopApp);

    var 시트순서 = ['고객명단', '치료사', '서비스목록', '일정', '차팅', '문자발송내역', '오프', '설정'];
    var 현재건수뱃지 = 시트순서.map(function (이름) {
      var c = Number(건수[이름] || 0);
      return '<div class="rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-center">' +
        '<div class="text-[11px] text-gray-500 font-semibold">' + esc(이름) + '</div>' +
        '<div class="text-sm font-bold text-gray-800 mt-0.5">' + c.toLocaleString('ko-KR') + '건</div>' +
        '</div>';
    }).join('');

    var 미리보기HTML = '';
    if (미리보기) {
      var 감지뱃지 = 시트순서.map(function (이름) {
        var 감지됨 = (미리보기.감지시트 || []).indexOf(이름) >= 0;
        var c = Number((미리보기.건수 || {})[이름] || 0);
        return '<div class="rounded-lg border px-2.5 py-2 text-center ' +
          (감지됨 ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50 opacity-60') + '">' +
          '<div class="text-[11px] font-semibold ' + (감지됨 ? 'text-emerald-700' : 'text-gray-400') + '">' +
          (감지됨 ? '<i class="fa-solid fa-check mr-0.5"></i>' : '') + esc(이름) + '</div>' +
          '<div class="text-sm font-bold ' + (감지됨 ? 'text-emerald-900' : 'text-gray-400') + ' mt-0.5">' +
          (감지됨 ? c.toLocaleString('ko-KR') + '건' : '시트 없음') + '</div></div>';
      }).join('');

      var 경고HTML = (미리보기.경고 || []).length
        ? '<div class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-1">' +
          미리보기.경고.map(function (w) { return '<div><i class="fa-solid fa-circle-info mr-1"></i>' + esc(w) + '</div>'; }).join('') +
          '</div>'
        : '';

      var 샘플목록 = [];
      if (미리보기.샘플 && (미리보기.샘플.고객명단 || []).length) {
        샘플목록.push('<div><span class="font-semibold text-gray-600">고객 샘플:</span> ' + esc(미리보기.샘플.고객명단.join(' / ')) + '</div>');
      }
      if (미리보기.샘플 && (미리보기.샘플.일정 || []).length) {
        샘플목록.push('<div><span class="font-semibold text-gray-600">일정 샘플:</span> ' + esc(미리보기.샘플.일정.join(' / ')) + '</div>');
      }
      var 샘플HTML = 샘플목록.length
        ? '<div class="mt-2.5 text-xs text-gray-500 bg-white border border-gray-200 rounded-lg px-3 py-2 space-y-1">' + 샘플목록.join('') + '</div>'
        : '';

      var 실행가능 = (미리보기.감지시트 || []).length > 0;
      미리보기HTML = `
        <div class="mt-4 rounded-xl border border-blue-200 bg-blue-50/50 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div class="text-sm font-bold text-blue-900">
              <i class="fa-solid fa-file-excel text-emerald-600 mr-1.5"></i>${esc(미리보기.파일명)}
              <span class="ml-1.5 text-xs font-semibold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">총 ${Number(미리보기.총건수 || 0).toLocaleString('ko-KR')}건 감지</span>
            </div>
            <button type="button" onclick="스프레드시트선택초기화()" class="text-xs text-gray-500 hover:text-gray-700 underline">다른 파일 선택</button>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${감지뱃지}</div>
          ${샘플HTML}
          ${경고HTML}
          <div class="mt-4 pt-3 border-t border-blue-200/80 space-y-2.5">
            <div class="text-xs font-bold text-gray-700">이전 방식 선택</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <label class="flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer ${window.로컬상태.이전모드 === 'replace' ? 'border-blue-500 bg-white ring-1 ring-blue-500' : 'border-gray-200 bg-white/70'}">
                <input type="radio" name="스프레드시트이전모드" value="replace" ${window.로컬상태.이전모드 === 'replace' ? 'checked' : ''} onchange="window.로컬상태.이전모드='replace';데이터관리모달렌더()" class="mt-0.5">
                <div>
                  <div class="font-bold text-gray-800">전체 교체 (최초 이전 권장)</div>
                  <div class="text-gray-500 mt-0.5">현재 DB를 자동 백업한 뒤 업로드한 시트 내용으로 교체합니다.</div>
                </div>
              </label>
              <label class="flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer ${window.로컬상태.이전모드 === 'merge' ? 'border-blue-500 bg-white ring-1 ring-blue-500' : 'border-gray-200 bg-white/70'}">
                <input type="radio" name="스프레드시트이전모드" value="merge" ${window.로컬상태.이전모드 === 'merge' ? 'checked' : ''} onchange="window.로컬상태.이전모드='merge';데이터관리모달렌더()" class="mt-0.5">
                <div>
                  <div class="font-bold text-gray-800">기존 데이터 유지 + 병합</div>
                  <div class="text-gray-500 mt-0.5">기존 로컬 자료를 유지하면서 동일 ID는 갱신, 신규 행은 추가합니다.</div>
                </div>
              </label>
            </div>
            <label class="inline-flex items-center gap-2 text-xs text-gray-700 cursor-pointer select-none">
              <input type="checkbox" ${window.로컬상태.설정포함 ? 'checked' : ''} onchange="window.로컬상태.설정포함=this.checked" class="h-4 w-4 rounded">
              <span><strong>설정</strong> 시트(메인 접속 비밀번호 · 관리자 비밀번호)도 함께 이전</span>
            </label>
            <button type="button" onclick="스프레드시트이전실행()" ${실행가능 ? '' : 'disabled'} class="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white font-bold py-3 rounded-lg shadow-sm">
              <i class="fa-solid fa-file-import mr-1.5"></i>스프레드시트 데이터 이전 실행
            </button>
          </div>
        </div>`;
    }

    var 백업목록HTML = 백업목록.length
      ? '<div class="mt-3 max-h-32 overflow-y-auto border border-gray-200 rounded-lg divide-y text-xs bg-white">' +
        백업목록.slice(0, 8).map(function (b) {
          return '<div class="flex items-center justify-between px-3 py-2 gap-2">' +
            '<span class="font-mono text-gray-700 truncate">' + esc(b.파일명) + '</span>' +
            '<span class="text-gray-400 shrink-0">' + esc(b.생성일시) + ' · ' + 바이트표시(b.크기) + '</span>' +
            '</div>';
        }).join('') + '</div>'
      : '<p class="text-xs text-gray-400 mt-2">아직 생성된 자동/수동 백업 파일이 없습니다.</p>';

    var 원내접속HTML = 정보.원내공유활성 && (정보.원내접속주소목록 || []).length
      ? '<div class="mt-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">' +
        '<div class="font-bold mb-1"><i class="fa-solid fa-wifi mr-1"></i>같은 원내 Wi-Fi의 다른 PC·태블릿 접속 주소</div>' +
        정보.원내접속주소목록.map(function (u) {
          return '<div class="flex items-center justify-between gap-2 py-0.5">' +
            '<span class="font-mono font-bold">' + esc(u) + '</span>' +
            '<button type="button" onclick="텍스트복사(\'' + js문자(u) + '\', \'접속 주소\')" class="text-emerald-700 hover:underline font-semibold"><i class="fa-solid fa-copy mr-0.5"></i>복사</button></div>';
        }).join('') + '</div>'
      : '';

    오픈모달(`
      <div class="p-6">
        <div class="flex items-start justify-between gap-3 pb-4 border-b mb-5">
          <div>
            <h3 class="text-lg font-bold text-gray-800"><i class="fa-solid fa-database text-emerald-600 mr-1.5"></i>데이터 이전 · 백업 · 로컬 앱 설정</h3>
            <p class="text-xs text-gray-500 mt-1">기존 구글 스프레드시트를 업로드해 바로 이전하거나, 현재 로컬 데이터를 엑셀로 백업할 수 있습니다.</p>
          </div>
          <button onclick="닫기모달()" class="text-gray-400 hover:text-gray-600"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>

        <!-- 1. 스프레드시트 업로드 이전 -->
        <div class="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 mb-5">
          <div class="flex items-center justify-between gap-2 mb-2">
            <h4 class="font-bold text-emerald-900 text-sm"><i class="fa-solid fa-file-arrow-up mr-1.5"></i>1. 기존 스프레드시트 업로드로 데이터 이전</h4>
            <span class="text-[11px] bg-white border border-emerald-200 text-emerald-700 font-semibold px-2 py-0.5 rounded-full">.xlsx · .xls · .ods · .csv</span>
          </div>
          <ol class="text-xs text-emerald-900/80 list-decimal list-inside space-y-0.5 mb-3">
            <li>구글 스프레드시트에서 <strong>파일 → 다운로드 → Microsoft Excel (.xlsx)</strong>로 내려받습니다.</li>
            <li>아래 버튼으로 내려받은 파일을 선택하면 8개 시트(고객명단·치료사·서비스목록·일정·차팅·문자발송내역·설정·오프)를 자동 분석합니다.</li>
            <li>과거 명칭(대상자명단·치료내용 등)과 날짜/시간/전화번호 형식도 자동으로 맞춰 가져옵니다.</li>
          </ol>
          <div class="flex flex-wrap items-center gap-2">
            <label class="inline-flex items-center gap-2 bg-white hover:bg-emerald-50 text-emerald-700 border-2 border-dashed border-emerald-400 font-bold text-sm px-4 py-2.5 rounded-xl cursor-pointer transition">
              <i class="fa-solid fa-upload"></i>
              <span>스프레드시트 파일 선택 (.xlsx)</span>
              <input id="스프레드시트파일입력" type="file" accept=".xlsx,.xls,.ods,.csv" onchange="스프레드시트파일선택(this)" class="hidden">
            </label>
            <span class="text-xs text-gray-500">업로드 전 자동으로 안전 백업이 생성됩니다.</span>
          </div>
          ${미리보기HTML}
        </div>

        <!-- 2. 현재 로컬 데이터 현황 및 백업/내보내기 -->
        <div class="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 mb-5">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h4 class="font-bold text-gray-800 text-sm"><i class="fa-solid fa-hard-drive text-blue-600 mr-1.5"></i>2. 현재 로컬 저장 데이터 & 백업</h4>
            <div class="flex flex-wrap gap-2">
              <button type="button" onclick="엑셀내보내기실행()" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-2 rounded-lg"><i class="fa-solid fa-file-excel mr-1"></i>엑셀(.xlsx) 내보내기</button>
              <button type="button" onclick="로컬백업실행()" class="bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 text-xs font-semibold px-3 py-2 rounded-lg"><i class="fa-solid fa-shield-halved mr-1"></i>즉시 DB 백업</button>
              ${데스크톱 ? '<button type="button" onclick="window.localDesktop.openDataFolder()" class="bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 text-xs font-semibold px-3 py-2 rounded-lg"><i class="fa-solid fa-folder-open mr-1"></i>데이터 폴더 열기</button>' : ''}
            </div>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${현재건수뱃지}</div>
          <div class="mt-3 text-[11px] text-gray-500 break-all">
            <span class="font-semibold">저장 위치:</span> <span class="font-mono">${esc(정보.데이터경로 || '')}</span>
          </div>
          ${백업목록HTML}
        </div>

        <!-- 3. 로컬 앱 동작 · 원내 공유 설정 -->
        <div class="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4">
          <h4 class="font-bold text-indigo-900 text-sm mb-3"><i class="fa-solid fa-desktop text-indigo-600 mr-1.5"></i>3. 로컬 앱 실행 · 원내 네트워크 공유</h4>
          <div class="space-y-2.5 text-sm">
            ${데스크톱 ? `
            <div class="rounded-xl border border-indigo-100 bg-white/80 p-3 space-y-2">
              <label class="flex items-start gap-2.5 cursor-pointer">
                <input id="로컬부팅자동실행" type="checkbox" ${정보.부팅자동실행 ? 'checked' : ''} onchange="var sub=$('로컬자동실행트레이'); if(sub) sub.disabled=!this.checked;" class="mt-1 h-4 w-4 rounded">
                <div>
                  <div class="font-semibold text-gray-800">Windows PC 부팅 시 자동 실행</div>
                  <div class="text-xs text-gray-500">서버 PC 전원을 켜면 로그인과 동시에 앱이 자동 시작되어 원내 공유와 자동문자가 바로 작동합니다.</div>
                </div>
              </label>
              <label class="flex items-center gap-2 pl-6 text-xs text-gray-600 cursor-pointer">
                <input id="로컬자동실행트레이" type="checkbox" ${정보.자동실행트레이시작 !== false ? 'checked' : ''} ${정보.부팅자동실행 ? '' : 'disabled'} class="h-3.5 w-3.5 rounded">
                <span>부팅 시 창을 띄우지 않고 시스템 트레이(백그라운드)로 조용히 시작</span>
              </label>
            </div>` : ''}
            <label class="flex items-start gap-2.5 cursor-pointer">
              <input id="로컬트레이상주" type="checkbox" ${정보.트레이상주 !== false ? 'checked' : ''} class="mt-1 h-4 w-4 rounded">
              <div>
                <div class="font-semibold text-gray-800">창 닫기(X) 시 시스템 트레이에서 계속 실행</div>
                <div class="text-xs text-gray-500">자동문자(24시간 전 재확인 · 수납 5분 후 감사)와 원내 공유가 꺼지지 않고 유지됩니다.</div>
              </div>
            </label>
            <label class="flex items-start gap-2.5 cursor-pointer">
              <input id="로컬원내공유" type="checkbox" ${정보.원내공유활성 ? 'checked' : ''} class="mt-1 h-4 w-4 rounded">
              <div>
                <div class="font-semibold text-gray-800">원내 네트워크 공유 허용 (다른 PC · 태블릿 동시 접속)</div>
                <div class="text-xs text-gray-500">켜면 같은 공유기(Wi-Fi) 안의 다른 기기에서 웹브라우저로 접속할 수 있으며, 문자 발송은 모두 이 PC의 국내 IP로 처리됩니다.</div>
              </div>
            </label>
          </div>
          ${원내접속HTML}
          <div class="mt-3 flex justify-end">
            <button type="button" onclick="로컬설정저장하기()" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2.5 rounded-lg"><i class="fa-solid fa-floppy-disk mr-1"></i>로컬 설정 저장</button>
          </div>
        </div>

        <!-- 4. 실시간 자동 업데이트 (GitHub Releases) -->
        ${데스크톱 ? `
        <div class="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <h4 class="font-bold text-slate-800 text-sm mb-2.5"><i class="fa-solid fa-cloud-arrow-down text-indigo-600 mr-1.5"></i>4. 프로그램 실시간 자동 업데이트</h4>
          <div id="로컬업데이트상태영역">${업데이트상태카드내부HTML()}</div>
        </div>` : ''}
      </div>
    `, 'max-w-4xl');
  };

  window.스프레드시트선택초기화 = function () {
    window.로컬상태.업로드파일명 = '';
    window.로컬상태.업로드Base64 = '';
    window.로컬상태.미리보기 = null;
    데이터관리모달렌더();
  };

  window.스프레드시트파일선택 = function (input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      showToast('파일 크기는 50MB 이하만 업로드할 수 있습니다', 'error');
      return;
    }
    로딩시작();
    var reader = new FileReader();
    reader.onload = function (ev) {
      로딩종료();
      var b64 = arrayBufferToBase64(ev.target.result);
      window.로컬상태.업로드파일명 = file.name;
      window.로컬상태.업로드Base64 = b64;
      서버호출('스프레드시트미리보기', {
        토큰: 상태.로그인토큰,
        파일명: file.name,
        파일Base64: b64,
      }, function (요약) {
        window.로컬상태.미리보기 = 요약;
        데이터관리모달렌더();
      });
    };
    reader.onerror = function () {
      로딩종료();
      showToast('파일을 읽지 못했습니다', 'error');
    };
    reader.readAsArrayBuffer(file);
  };

  window.스프레드시트이전실행 = function () {
    var s = window.로컬상태;
    if (!s.업로드Base64 || !s.미리보기) {
      showToast('먼저 스프레드시트 파일을 선택해 주세요', 'error');
      return;
    }
    var 안내 = s.이전모드 === 'replace'
      ? '현재 로컬 데이터를 자동 백업한 뒤, 업로드한 스프레드시트(' + s.미리보기.파일명 + ', 총 ' + Number(s.미리보기.총건수 || 0).toLocaleString('ko-KR') + '건)로 교체할까요?'
      : '기존 로컬 데이터를 유지하면서 업로드한 스프레드시트(' + s.미리보기.파일명 + ')의 데이터를 병합할까요?';
    if (!confirm(안내)) return;

    서버호출('스프레드시트가져오기', {
      토큰: 상태.로그인토큰,
      파일명: s.업로드파일명,
      파일Base64: s.업로드Base64,
      모드: s.이전모드,
      설정포함: s.설정포함,
    }, function (값, 결과) {
      if (값 && 값.새토큰) {
        상태.로그인토큰 = 값.새토큰;
        sessionStorage.setItem('치료차팅토큰', 값.새토큰);
      }
      s.업로드파일명 = '';
      s.업로드Base64 = '';
      s.미리보기 = null;
      showToast(결과.message, 'success');
      닫기모달();
      상태.차팅로딩됨 = false;
      새로고침데이터(function () {
        render();
        차팅데이터불러오기(function () { render(); }, true);
      });
    });
  };

  window.엑셀내보내기실행 = function () {
    로딩시작();
    fetch('/api/export-xlsx', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Local-App': '1',
      },
      body: JSON.stringify({ 토큰: 상태.로그인토큰 }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (d) {
            throw new Error(d.message || '내보내기 실패 (HTTP ' + res.status + ')');
          });
        }
        return res.blob();
      })
      .then(function (blob) {
        로딩종료();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = '원탑통증재활센터_백업_' + fmtDate(new Date()) + '.xlsx';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        showToast('스프레드시트(.xlsx) 백업 파일을 내려받았습니다', 'success');
      })
      .catch(function (err) {
        로딩종료();
        showToast(err.message || '엑셀 내보내기 실패', 'error');
      });
  };

  window.로컬백업실행 = function () {
    서버호출('로컬백업생성', { 토큰: 상태.로그인토큰 }, function (값, 결과) {
      if (window.로컬상태.정보 && 값 && 값.백업목록) {
        window.로컬상태.정보.백업목록 = 값.백업목록;
      }
      showToast(결과.message, 'success');
      데이터관리모달렌더();
    });
  };

  window.로컬설정저장하기 = function () {
    var 데이터 = {
      토큰: 상태.로그인토큰,
      부팅자동실행: $('로컬부팅자동실행') ? $('로컬부팅자동실행').checked : !!(window.로컬상태.정보 && window.로컬상태.정보.부팅자동실행),
      자동실행트레이시작: $('로컬자동실행트레이') ? $('로컬자동실행트레이').checked : true,
      트레이상주: $('로컬트레이상주') ? $('로컬트레이상주').checked : true,
      원내공유활성: $('로컬원내공유') ? $('로컬원내공유').checked : false,
    };
    서버호출('로컬설정저장', 데이터, function (값, 결과) {
      if (window.로컬상태.정보 && 값) {
        Object.assign(window.로컬상태.정보, 값);
      }
      showToast(결과.message, 'success');
      데이터관리모달렌더();
    });
  };
})();
