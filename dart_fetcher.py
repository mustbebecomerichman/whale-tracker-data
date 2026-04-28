"""
dart_fetcher.py — Whale Tracker Pro 데이터 수집기
══════════════════════════════════════════════════════
  [A] DART OpenAPI  → 국민연금 & 대량보유 데이터 수집
  [B] 한국투자증권  → 내 포트폴리오 자동 수집
  [C] Firebase      → 전체 사용자에게 자동 반영

설치:
  pip install requests firebase-admin

실행:
  python dart_fetcher.py          # DART + KIS 수동 실행
  python dart_fetcher.py --dart   # 국민연금·대량보유만
  python dart_fetcher.py --kis    # 내 포트폴리오만
  python dart_fetcher.py --auto   # GitHub Actions용 (환경변수 사용)
══════════════════════════════════════════════════════
"""

import os, sys, json, time, re, html, io, zipfile, requests
from datetime import datetime, timedelta
from pathlib import Path

# ──────────────────────────────────────────────────────
#  ⚙️  설정
# ──────────────────────────────────────────────────────

# GitHub Actions 환경변수 우선, 없으면 직접 입력값 사용
DART_API_KEY   = os.environ.get("DART_API_KEY",   "")   # 환경변수 또는 직접 입력
DART_BASE_URL  = "https://opendart.fss.or.kr/api"

# KIS API 인증 정보 — 환경변수 우선, 없으면 로컬 직접 입력값 사용
# ▶ GitHub Actions: GitHub Secrets에 등록
# ▶ 로컬 실행: 아래 "" 안에 직접 값 입력 (절대 GitHub에 올리지 마세요)
KIS_APP_KEY    = os.environ.get("KIS_APP_KEY",    "")   # 환경변수 또는 직접 입력
KIS_APP_SECRET = os.environ.get("KIS_APP_SECRET", "")   # 환경변수 또는 직접 입력
KIS_ACCOUNT_NO = os.environ.get("KIS_ACCOUNT_NO", "")  # GitHub Secrets에 등록 필요
KIS_ACCOUNT_TYPE = "01"
KIS_MOCK       = False
KIS_BASE       = "https://openapivts.koreainvestment.com:29443" if KIS_MOCK else "https://openapi.koreainvestment.com:9443"

# Firebase 설정 (GitHub Actions에서 환경변수로 주입)
FB_SERVICE_ACCOUNT_JSON = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "")  # JSON 문자열
FB_CRED_FILE   = "serviceAccountKey.json"   # 로컬 실행 시
FB_PROJECT     = "whaletracker-pro"

TODAY          = datetime.today()
END_DATE       = TODAY.strftime("%Y%m%d")
START_DATE     = (TODAY - timedelta(days=90)).strftime("%Y%m%d")
LONG_START     = (TODAY - timedelta(days=180)).strftime("%Y%m%d")
YEAR_START     = TODAY.strftime("%Y") + "0101"

QUANT_KOSPI_LIMIT = int(os.environ.get("QUANT_KOSPI_LIMIT", "200"))
QUANT_KOSDAQ_LIMIT = int(os.environ.get("QUANT_KOSDAQ_LIMIT", "150"))
NPS_DOMESTIC_LOOKBACK_DAYS = int(os.environ.get("NPS_DOMESTIC_LOOKBACK_DAYS", "730"))
NPS_DOMESTIC_LIMIT = int(os.environ.get("NPS_DOMESTIC_LIMIT", "500"))
NPS_OVERSEAS_LIMIT = int(os.environ.get("NPS_OVERSEAS_LIMIT", "120"))
ALERT_LOOKBACK_DAYS = int(os.environ.get("ALERT_LOOKBACK_DAYS", "90"))
ALERT_LIMIT = int(os.environ.get("ALERT_LIMIT", "300"))
DISCLOSURE_SCAN_KOSPI_LIMIT = int(os.environ.get("DISCLOSURE_SCAN_KOSPI_LIMIT", str(QUANT_KOSPI_LIMIT)))
DISCLOSURE_SCAN_KOSDAQ_LIMIT = int(os.environ.get("DISCLOSURE_SCAN_KOSDAQ_LIMIT", str(QUANT_KOSDAQ_LIMIT)))
GLOBAL_WHALE_TOP_N = int(os.environ.get("GLOBAL_WHALE_TOP_N", "100"))
NPS_13F_CIK = "0001608046"

# ──────────────────────────────────────────────────────
#  유틸
# ──────────────────────────────────────────────────────

def dart_get(endpoint, params, retries=3):
    url = f"{DART_BASE_URL}/{endpoint}.json"
    params["crtfc_key"] = DART_API_KEY
    for i in range(retries):
        try:
            r = requests.get(url, params=params, timeout=15)
            r.raise_for_status()
            return r.json()
        except requests.exceptions.Timeout:
            if i < retries - 1:
                print(f"  ⚠ 타임아웃, 재시도 {i+2}/{retries}...")
                time.sleep(2)
            else:
                raise

def parse_pct(val):
    try:
        return float(str(val).replace("%","").replace(",","").strip())
    except:
        return 0.0

def fmt_date(raw):
    try:
        return f"{raw[:4]}.{raw[4:6]}.{raw[6:8]}"
    except:
        return raw

def date_windows(days, chunk_days=90):
    end = TODAY
    start = TODAY - timedelta(days=days)
    windows = []
    cur = start
    while cur <= end:
        nxt = min(cur + timedelta(days=chunk_days - 1), end)
        windows.append((cur.strftime("%Y%m%d"), nxt.strftime("%Y%m%d")))
        cur = nxt + timedelta(days=1)
    return windows

def pn(s):
    if not s or str(s).strip() in ("","0","-","#N/A"):
        return 0
    try:
        return float(str(s).replace(",","").strip())
    except:
        return 0

def clean_html_text(raw):
    text = re.sub(r"<[^>]+>", " ", str(raw or ""))
    text = html.unescape(text).replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()

def nf(raw, default=0.0):
    text = clean_html_text(raw).replace(",", "").replace("%", "")
    m = re.search(r"[-+]?\d+(?:\.\d+)?", text)
    if not m:
        return default
    try:
        return float(m.group(0))
    except:
        return default

def infer_sector(name):
    rules = [
        (r"삼성전자|하이닉스|반도체|DB하이텍|한미반도체", "반도체"),
        (r"현대차|기아|모비스|글로비스|HL만도", "자동차"),
        (r"금융|은행|증권|보험|카드|지주|KB|신한|하나|우리", "금융"),
        (r"바이오|셀트리온|제약|알테오젠|유한양행|삼성바이오", "바이오"),
        (r"에코프로|SDI|전지|배터리|엘앤에프|포스코퓨처엠", "2차전지"),
        (r"NAVER|카카오|엔씨|넷마블|게임|펄어비스", "인터넷/게임"),
        (r"엔터|SM|JYP|와이지|하이브", "엔터"),
        (r"텔레콤|KT|LG유플러스", "통신"),
        (r"조선|중공업|오션|미포", "조선"),
        (r"전력|일렉트릭|LS|효성중공업", "전력기기"),
        (r"화학|정유|S-Oil|SK이노베이션", "화학/에너지"),
        (r"식품|오리온|농심|CJ|삼양식품|KT&G", "필수소비재"),
        (r"건설|건설기계|현대건설|대우건설", "건설"),
        (r"철강|POSCO|포스코|현대제철", "철강"),
    ]
    for pat, sector in rules:
        if re.search(pat, name, re.I):
            return sector
    return "기타"

def fetch_naver_market_sum(market="KOSPI", limit=200):
    """네이버 시가총액 페이지에서 KOSPI/KOSDAQ 상위 종목을 수집한다."""
    sosok = "0" if market == "KOSPI" else "1"
    rows, seen = [], set()
    headers = {"User-Agent": "Mozilla/5.0 WhaleTrackerPro"}
    max_pages = (limit // 50) + 3
    for page in range(1, max_pages + 1):
        url = f"https://finance.naver.com/sise/sise_market_sum.naver?sosok={sosok}&page={page}"
        r = requests.get(url, headers=headers, timeout=15)
        r.encoding = "euc-kr"
        blocks = re.findall(r"<tr[^>]*>(.*?)</tr>", r.text, re.S | re.I)
        added = 0
        for block in blocks:
            m = re.search(r"code=(\d{6})[^>]*class=\"tltle\"[^>]*>(.*?)</a>", block, re.S | re.I)
            if not m:
                continue
            code, name = m.group(1), clean_html_text(m.group(2))
            if code in seen:
                continue
            nums = [clean_html_text(x) for x in re.findall(r"<td[^>]*class=\"number\"[^>]*>(.*?)</td>", block, re.S | re.I)]
            price = nf(nums[0]) if len(nums) > 0 else 0
            momentum = nf(nums[2]) if len(nums) > 2 else 0
            market_cap = nf(nums[4]) if len(nums) > 4 else 0
            volume = nf(nums[7]) if len(nums) > 7 else 0
            per = nf(nums[8], 20) if len(nums) > 8 else 20
            roe = nf(nums[9], 8) if len(nums) > 9 else 8
            if per <= 0:
                per = 35
            rows.append({
                "code": code,
                "name": name,
                "market": market,
                "sector": infer_sector(name),
                "price": int(price) if price else 0,
                "marketCap": int(market_cap) if market_cap else 0,
                "per": round(per, 2),
                "pbr": 1.5,
                "roe": round(roe, 2),
                "dividend": 0,
                "momentum": round(momentum, 2),
                "volatility": round(min(65, max(18, abs(momentum) * 8 + 25)), 1),
                "debt": 50,
                "volume": int(volume) if volume else 0,
                "note": "네이버 시총 상위 자동수집",
            })
            seen.add(code)
            added += 1
            if len(rows) >= limit:
                break
        if len(rows) >= limit or added == 0:
            break
        time.sleep(0.25)
    return rows[:limit]

_corp_code_map = None
_market_universe_cache = {}
_majorstock_cache = {}

def fetch_corp_code_map():
    """DART 고유번호 ZIP에서 stock_code -> corp_code 매핑을 만든다."""
    global _corp_code_map
    if _corp_code_map is not None:
        return _corp_code_map
    if not DART_API_KEY:
        print("  ⚠ DART_API_KEY 없음: DART 공시 수집 불가")
        _corp_code_map = {}
        return _corp_code_map
    url = f"{DART_BASE_URL}/corpCode.xml"
    r = requests.get(url, params={"crtfc_key": DART_API_KEY}, timeout=30)
    r.raise_for_status()
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        xml_name = zf.namelist()[0]
        root = ET.fromstring(zf.read(xml_name))
    mapping = {}
    for item in root.iter("list"):
        corp_code = (item.findtext("corp_code") or "").strip()
        stock_code = (item.findtext("stock_code") or "").strip()
        corp_name = (item.findtext("corp_name") or "").strip()
        if stock_code:
            mapping[stock_code] = {"corp_code": corp_code, "name": corp_name}
    _corp_code_map = mapping
    print(f"  ✅ DART 고유번호 매핑: {len(mapping)}개 상장 종목")
    return mapping

def fetch_market_universe_for_disclosures():
    """대량보유/국민연금 스캔용 상위 KOSPI/KOSDAQ 유니버스."""
    key = (DISCLOSURE_SCAN_KOSPI_LIMIT, DISCLOSURE_SCAN_KOSDAQ_LIMIT)
    if key in _market_universe_cache:
        return _market_universe_cache[key]
    kospi = fetch_naver_market_sum("KOSPI", DISCLOSURE_SCAN_KOSPI_LIMIT)
    kosdaq = fetch_naver_market_sum("KOSDAQ", DISCLOSURE_SCAN_KOSDAQ_LIMIT)
    rows = []
    seen = set()
    for row in kospi + kosdaq:
        code = row.get("code", "")
        if code and code not in seen:
            rows.append(row)
            seen.add(code)
    _market_universe_cache[key] = rows
    print(f"  ✅ 공시 스캔 유니버스: {len(rows)}개")
    return rows

def get_majorstock_items(corp_code):
    """DART majorstock: 회사별 5% 이상 대량보유 보고 목록."""
    if not corp_code:
        return []
    if corp_code in _majorstock_cache:
        return _majorstock_cache[corp_code]
    data = dart_get("majorstock", {"corp_code": corp_code})
    rows = data.get("list", []) if data and data.get("status") == "000" else []
    _majorstock_cache[corp_code] = rows
    time.sleep(0.08)
    return rows

def holder_name(item):
    return item.get("repror") or item.get("rcpter_nm") or item.get("reporter") or ""

def item_report_date(item):
    return item.get("rcept_dt") or item.get("rcept_date") or ""

def item_pct(item):
    return parse_pct(item.get("stkrt") or item.get("stkqy_irds") or 0)

def item_delta_pct(item):
    return parse_pct(item.get("stkrt_irds") or item.get("stkqy_irds_change") or 0)

def fetch_quant_universe():
    print("\n📡 [DART 3/3] 퀀트 스크리너 유니버스 수집 중...")
    try:
        kospi = fetch_naver_market_sum("KOSPI", QUANT_KOSPI_LIMIT)
        kosdaq = fetch_naver_market_sum("KOSDAQ", QUANT_KOSDAQ_LIMIT)
        universe = kospi + kosdaq
        print(f"  ✅ 퀀트 유니버스: KOSPI {len(kospi)}개, KOSDAQ {len(kosdaq)}개")
        return universe
    except Exception as e:
        print(f"  ⚠ 퀀트 유니버스 수집 실패: {e}")
        return []

# ──────────────────────────────────────────────────────
#  [A] DART 국민연금 포트폴리오 수집
# ──────────────────────────────────────────────────────

def fetch_nps_portfolio():
    print("\n📡 [DART 1/2] 국민연금 포트폴리오 수집 중...")
    portfolio = {}
    corp_map = fetch_corp_code_map()
    universe = fetch_market_universe_for_disclosures()
    cutoff = (TODAY - timedelta(days=NPS_DOMESTIC_LOOKBACK_DAYS)).strftime("%Y%m%d")
    for i, row in enumerate(universe, 1):
        code = row.get("code", "")
        corp = corp_map.get(code, {})
        for item in get_majorstock_items(corp.get("corp_code", "")):
            holder = holder_name(item)
            if "국민연금" not in holder:
                continue
            dt = item_report_date(item)
            if dt and dt < cutoff:
                continue
            key = code or item.get("corp_code") or item.get("corp_name", "")
            if key not in portfolio or dt > portfolio[key].get("_dt",""):
                portfolio[key] = {
                    **item,
                    "stock_code": code,
                    "corp_name": row.get("name") or item.get("corp_name",""),
                    "_dt": dt,
                    "_market": row.get("market","KOSPI"),
                    "_holder": holder,
                }
        if i % 100 == 0:
            print(f"  진행: {i}/{len(universe)}개")

    result = []
    for item in portfolio.values():
        pct = item_pct(item)
        delta = item_delta_pct(item)
        trend = "increase" if delta>0 else ("decrease" if delta<0 else "hold")
        try:
            sn = int(str(item.get("stkqy","")).replace(",",""))
            shares = (f"{sn//100_000_000}억주" if sn>=100_000_000
                      else f"{sn//10_000}만주" if sn>=10_000 else f"{sn:,}주")
        except:
            shares = str(item.get("stkqy",""))
        result.append({
            "code":item.get("stock_code",""),"name":item.get("corp_name",""),
            "market":item.get("_market","KOSPI"),"shares":shares,
            "pct":round(pct,2),"delta":round(delta,2),"trend":trend,
            "holder":item.get("_holder") or holder_name(item),
            "date":fmt_date(item_report_date(item)),
        })
    result.sort(key=lambda x: x["pct"], reverse=True)
    print(f"  ✅ 국민연금 보유 종목: {len(result)}개")
    return result[:NPS_DOMESTIC_LIMIT]

def fetch_alert5():
    print("\n📡 [DART 2/2] 5%↑ 대량보유 알림 수집 중...")
    alerts = {}
    corp_map = fetch_corp_code_map()
    universe = fetch_market_universe_for_disclosures()
    recent = (TODAY - timedelta(days=ALERT_LOOKBACK_DAYS)).strftime("%Y%m%d")
    for i, row in enumerate(universe, 1):
        code = row.get("code", "")
        corp = corp_map.get(code, {})
        for item in get_majorstock_items(corp.get("corp_code", "")):
            dt = item_report_date(item)
            if dt and dt < recent:
                continue
            key = "|".join([dt, code, holder_name(item)])
            alerts[key] = {
                **item,
                "stock_code": code,
                "corp_name": row.get("name") or item.get("corp_name",""),
                "_holder": holder_name(item),
            }
        if i % 100 == 0:
            print(f"  진행: {i}/{len(universe)}개")
    result = []
    for item in alerts.values():
        after  = item_pct(item)
        delta  = item_delta_pct(item)
        before = round(after - delta, 2)
        t = "buy" if before<=0 else ("increase" if delta>0 else "decrease")
        result.append({
            "name":item.get("corp_name",""),"code":item.get("stock_code",""),
            "type":t,"holder":item.get("_holder") or holder_name(item),
            "before":max(before,0),"after":after,"delta":round(delta,2),
            "date":fmt_date(item_report_date(item)),
        })
    result.sort(key=lambda x: x["date"], reverse=True)
    print(f"  ✅ 대량보유 공시: {len(result)}건")
    return result[:ALERT_LIMIT]

def build_alert10(alerts):
    rows = []
    for item in alerts:
        if item.get("after", 0) < 10:
            continue
        rows.append({
            "name": item.get("name",""),
            "holder": item.get("holder",""),
            "pct": item.get("after",0),
            "delta": item.get("delta",0),
            "date": item.get("date",""),
            "note": "5% 보고 중 10% 이상",
        })
    rows.sort(key=lambda x: (x["date"], x["pct"]), reverse=True)
    return rows[:100]

# ──────────────────────────────────────────────────────
#  [B] 한국투자증권 포트폴리오
# ──────────────────────────────────────────────────────

_kis_token = None
_kis_token_exp = None

def kis_get_token():
    global _kis_token, _kis_token_exp
    if _kis_token and _kis_token_exp and datetime.now() < _kis_token_exp:
        return _kis_token
    print("  🔑 KIS 토큰 발급 중...")
    r = requests.post(f"{KIS_BASE}/oauth2/tokenP", json={
        "grant_type":"client_credentials","appkey":KIS_APP_KEY,"appsecret":KIS_APP_SECRET
    }, timeout=10)
    r.raise_for_status()
    data = r.json()
    if "access_token" not in data:
        raise RuntimeError(f"토큰 발급 실패: {data}")
    _kis_token = data["access_token"]
    _kis_token_exp = datetime.now() + timedelta(hours=23, minutes=50)
    print("  ✅ 토큰 발급 완료")
    return _kis_token

def kis_hdr(tr_id):
    return {
        "Content-Type":"application/json; charset=utf-8",
        "authorization":f"Bearer {kis_get_token()}",
        "appkey":KIS_APP_KEY,"appsecret":KIS_APP_SECRET,
        "tr_id":tr_id,"custtype":"P",
    }

def kis_fetch_balance():
    print("\n📡 [KIS 1/2] 국내 주식 잔고 조회 중...")
    tr_id = "VTTC8434R" if KIS_MOCK else "TTTC8434R"
    r = requests.get(f"{KIS_BASE}/uapi/domestic-stock/v1/trading/inquire-balance",
        headers=kis_hdr(tr_id), params={
            "CANO":KIS_ACCOUNT_NO,"ACNT_PRDT_CD":KIS_ACCOUNT_TYPE,
            "AFHR_FLPR_YN":"N","OFL_YN":"N","INQR_DVSN":"01",
            "UNPR_DVSN":"01","FUND_STTL_ICLD_YN":"N",
            "FNCG_AMT_AUTO_RDPT_YN":"N","PRCS_DVSN":"00",
            "CTX_AREA_FK100":"","CTX_AREA_NK100":"",
        }, timeout=15)
    r.raise_for_status()
    data = r.json()
    holdings, summary = [], {}
    if data.get("rt_cd") == "0":
        for item in data.get("output1",[]):
            qty = pn(item.get("hldg_qty"))
            if qty <= 0: continue
            cur = pn(item.get("prpr")); avg = pn(item.get("pchs_avg_pric"))
            ev = pn(item.get("evlu_amt")); bp = pn(item.get("pchs_amt"))
            pl = pn(item.get("evlu_pfls_amt"))
            rate = (pl/bp*100) if bp else 0
            holdings.append({
                "code":item.get("pdno",""),"name":item.get("prdt_name",""),
                "market":"KOSPI","qty":int(qty),"price":int(cur),"avgBuy":round(avg,0),
                "pnl":int(pl),"rate":round(rate,2),"eval":int(ev),"purchase":int(bp),
                "brokerage":"한국투자증권","date":TODAY.strftime("%Y-%m-%d"),
            })
        for out2 in data.get("output2",[]):
            te = pn(out2.get("tot_evlu_amt")); tb = pn(out2.get("pchs_amt_smtl_amt"))
            if te > 0:
                summary = {
                    "total":int(te),"purchase":int(tb),"pnl":int(te-tb),
                    "returnRate":round((te-tb)/tb*100,2) if tb else 0,
                    "numStocks":len(holdings),
                    "profitCount":sum(1 for h in holdings if h["pnl"]>=0),
                    "lossCount":sum(1 for h in holdings if h["pnl"]<0),
                }
                break
    print(f"  ✅ 보유 종목: {len(holdings)}개")
    return holdings, summary

def kis_fetch_transactions():
    print("\n📡 [KIS 2/2] 거래 내역 조회 중...")
    tr_id = "VTTC8001R" if KIS_MOCK else "TTTC8001R"
    all_txs, ctx_fk, ctx_nk = [], "", ""
    while True:
        r = requests.get(f"{KIS_BASE}/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
            headers=kis_hdr(tr_id), params={
                "CANO":KIS_ACCOUNT_NO,"ACNT_PRDT_CD":KIS_ACCOUNT_TYPE,
                "INQR_STRT_DT":YEAR_START,"INQR_END_DT":END_DATE,
                "SLL_BUY_DVSN_CD":"00","INQR_DVSN":"00","PDNO":"",
                "CCLD_DVSN":"01","ORD_GNO_BRNO":"","ODNO":"",
                "INQR_DVSN_3":"00","INQR_DVSN_1":"",
                "CTX_AREA_FK100":ctx_fk,"CTX_AREA_NK100":ctx_nk,
            }, timeout=15)
        r.raise_for_status()
        data = r.json()
        if data.get("rt_cd") != "0": break
        for item in data.get("output1",[]):
            qty = pn(item.get("tot_ccld_qty"))
            if qty <= 0: continue
            price = pn(item.get("avg_prvs")); avg = pn(item.get("pchs_avg_pric"))
            ev = qty*price; bp = qty*avg; pl = ev-bp
            raw = item.get("ord_dt","")
            try: dt = f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"
            except: dt = raw
            all_txs.append({
                "date":dt,"brokerage":"한국투자증권","acctType":"위탁",
                "code":item.get("pdno",""),"name":item.get("prdt_name",""),
                "qty":int(qty),"price":int(price),"avgBuy":int(avg),
                "pnl":int(pl),"rate":round(pl/bp*100,2) if bp else 0,
                "eval":int(ev),"purchase":int(bp),
                "fee":int(pn(item.get("fee",0))),
            })
        if data.get("tr_cont","") not in ("F","M"): break
        ctx_fk = data.get("ctx_area_fk100","")
        ctx_nk = data.get("ctx_area_nk100","")
        time.sleep(0.3)
    print(f"  ✅ 거래 내역: {len(all_txs)}건")
    return all_txs

# ──────────────────────────────────────────────────────
#  [C] Firebase 업로드
# ──────────────────────────────────────────────────────

def get_firebase_db():
    """Firebase Admin SDK 초기화 (로컬 키 파일 또는 환경변수)"""
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as fstore

        if firebase_admin._apps:
            return fstore.client()

        if FB_SERVICE_ACCOUNT_JSON:
            # GitHub Actions: 환경변수에서 JSON 문자열로 인증
            import tempfile
            with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
                f.write(FB_SERVICE_ACCOUNT_JSON)
                tmp = f.name
            cred = credentials.Certificate(tmp)
        elif Path(FB_CRED_FILE).exists():
            # 로컬: serviceAccountKey.json 파일로 인증
            cred = credentials.Certificate(FB_CRED_FILE)
        else:
            print(f"  ⚠ Firebase 인증 파일 없음 ({FB_CRED_FILE})")
            print("  → Firebase Console → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성")
            return None

        firebase_admin.initialize_app(cred)
        return fstore.client()
    except ImportError:
        print("  ⚠ firebase-admin 없음: pip install firebase-admin")
        return None

def upload_to_firebase(collection, doc_id, data):
    db = get_firebase_db()
    if not db: return False
    from firebase_admin import firestore as fstore
    db.collection(collection).document(doc_id).set({
        **data, "updated_at": fstore.SERVER_TIMESTAMP
    })
    print(f"  ☁  Firebase '{collection}/{doc_id}' 업로드 완료")
    return True

# ──────────────────────────────────────────────────────
#  메인
# ──────────────────────────────────────────────────────

def run_dart(auto=False):
    print("\n" + "═"*52)
    print("  📊 DART — 국민연금 & 대량보유 데이터 수집")
    print("═"*52)
    nps  = fetch_nps_portfolio()
    al5  = fetch_alert5()
    al10 = build_alert10(al5)
    nps_overseas = fetch_nps_overseas_portfolio(limit=NPS_OVERSEAS_LIMIT)
    quant = fetch_quant_universe()
    out  = {
        "data_updated_at": TODAY.isoformat(),
        "nps_portfolio": nps,
        "nps_overseas": nps_overseas,
        "alert5": al5,
        "alert10": al10,
        "meta": {
            "schedule": "매일 10:00 KST",
            "nps_domestic_lookback_days": NPS_DOMESTIC_LOOKBACK_DAYS,
            "alert_lookback_days": ALERT_LOOKBACK_DAYS,
            "quant_target": f"KOSPI {QUANT_KOSPI_LIMIT} + KOSDAQ {QUANT_KOSDAQ_LIMIT}",
        },
    }
    if quant:
        out["quant_universe"] = quant
    # JSON 저장
    with open("whale_data.json","w",encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n  💾 whale_data.json 저장 완료 (국민연금 국내 {len(nps)}개, 해외 {len(nps_overseas)}개, 알림 {len(al5)}건, 퀀트 {len(quant)}개)")

    # Firebase 자동 업로드 (--auto 모드 또는 서비스 계정 파일 있을 때)
    if auto or Path(FB_CRED_FILE).exists() or FB_SERVICE_ACCOUNT_JSON:
        print("  ☁  Firebase 자동 업로드 중...")
        if upload_to_firebase("whale_data", "current", out):
            print("  ✅ 모든 사용자에게 자동 반영 완료!")
        else:
            print("  ⚠ Firebase 업로드 실패 - 수동 업로드 필요")
            print("     웹사이트 관리자 패널 → 고래 데이터 업로드에 whale_data.json 내용 붙여넣기")
    else:
        print("\n  💡 수동 업로드 방법:")
        print("     웹사이트 → ⚙ 관리자 패널 → '고래 데이터 업로드'에 whale_data.json 내용 붙여넣기")

def run_kis():
    print("\n" + "═"*52)
    print("  🏦 KIS — 한국투자증권 포트폴리오 수집")
    print("═"*52)
    try:
        holdings, summary = kis_fetch_balance()
        txs = kis_fetch_transactions()
        out = {
            "updatedAt":  TODAY.strftime("%Y-%m-%d"),
            "summary":    summary,
            "accounts":   [{"name":"한국투자증권","eval":summary.get("total",0),
                            "purchase":summary.get("purchase",0),"rate":summary.get("returnRate",0)}],
            "transactions": {str(TODAY.year): txs},
        }
        with open("my_portfolio.json","w",encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"\n  💾 my_portfolio.json 저장 완료")
        print(f"     총 평가금액: {summary.get('total',0):,}원")
        print(f"     수익률: {summary.get('returnRate',0):+.2f}%")
        print(f"     거래 내역: {len(txs)}건")
        print("\n  💡 웹사이트 → 내 포트폴리오 → JSON 파일 업로드에서 my_portfolio.json 선택")
    except Exception as e:
        print(f"\n  ❌ KIS 오류: {e}")
        if "401" in str(e): print("     → App Key/Secret을 확인하세요.")

# ──────────────────────────────────────────────────────
#  [D] SEC EDGAR 13F — 글로벌 고래 포트폴리오 수집
# ──────────────────────────────────────────────────────
# 미국 SEC에 의무 신고되는 13F 보고서를 파싱해
# 주요 헤지펀드·연기금의 실제 보유 종목을 수집합니다.

SEC_AGENTS = {'User-Agent': 'WhaleTrackerPro contact@whaletracker.pro'}  # SEC 필수 헤더

# 추적할 기관 목록 (CIK: 미국 증권거래위원회 등록번호)
WHALES_13F = [
    {"name": "워런 버핏 (Berkshire Hathaway)", "emoji": "🎩", "cik": "0001067983"},
    {"name": "레이 달리오 (Bridgewater)",       "emoji": "🌊", "cik": "0001350694"},
    {"name": "빌 애크먼 (Pershing Square)",     "emoji": "📊", "cik": "0001336528"},
    {"name": "조지 소로스 (Soros Fund)",        "emoji": "💰", "cik": "0001439124"},
    {"name": "데이비드 테퍼 (Appaloosa)",       "emoji": "🦁", "cik": "0001418838"},
    {"name": "스탠리 드러켄밀러",               "emoji": "🔭", "cik": "0001536411"},
    {"name": "Tiger Global Management",         "emoji": "🐯", "cik": "0001167483"},
    {"name": "블랙록 (BlackRock)",              "emoji": "🏦", "cik": "0001086364"},
    {"name": "뱅가드 (Vanguard)",               "emoji": "⛵", "cik": "0000102909"},
]

def get_latest_13f_accession(cik: str) -> tuple:
    """최신 13F-HR 제출 번호와 날짜 반환"""
    url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    r = requests.get(url, headers=SEC_AGENTS, timeout=15)
    r.raise_for_status()
    data = r.json()
    filings = data.get("filings", {}).get("recent", {})
    forms  = filings.get("form", [])
    accnos = filings.get("accessionNumber", [])
    dates  = filings.get("filingDate", [])
    for i, f in enumerate(forms):
        if f in ("13F-HR", "13F-HR/A"):
            return accnos[i], dates[i]
    return None, None

def format_13f_value(value_thousand):
    dollars = value_thousand * 1000
    if dollars >= 1_000_000_000_000:
        return f"{dollars/1_000_000_000_000:.2f}조$"
    if dollars >= 1_000_000_000:
        return f"{dollars/1_000_000_000:.2f}B$"
    if dollars >= 1_000_000:
        return f"{dollars/1_000_000:.1f}M$"
    return f"{dollars:,.0f}$"

def get_13f_report(cik: str, accession: str, top_n: int = 30) -> dict:
    """13F 보고서에서 전체 보유 종목 수, 총액, 상위 종목을 파싱"""
    import xml.etree.ElementTree as ET
    acc_clean = accession.replace("-", "")
    # 인덱스 페이지에서 XML 파일명 확인
    idx_url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_clean}/{accession}-index.htm"
    try:
        r = requests.get(idx_url, headers=SEC_AGENTS, timeout=15)
        # informationTable.xml 또는 primary_doc.xml 탐색
        import re as re_mod
        xml_files = re_mod.findall(r'href="([^"]*(?:informationTable|infotable)[^"]*\.xml)"', r.text, re_mod.I)
        if not xml_files:
            xml_files = re_mod.findall(r'href="([^"]*\.xml)"', r.text, re_mod.I)
        if not xml_files:
            return {"top": [], "count": 0, "total_value_thousand": 0}
        holdings = []
        for xml_file in xml_files:
            xml_url = "https://www.sec.gov" + xml_file if xml_file.startswith("/") else \
                      f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_clean}/{xml_file}"
            xr = requests.get(xml_url, headers=SEC_AGENTS, timeout=15)
            root = ET.fromstring(xr.content)
            parsed = []
            for info in root.iter():
                if info.tag.split("}")[-1].lower() == "infotable":
                    name    = (info.find(".//{*}nameOfIssuer") or info.find(".//{*}NAMEOFISSUER"))
                    cusip   = (info.find(".//{*}cusip") or info.find(".//{*}CUSIP"))
                    value   = (info.find(".//{*}value") or info.find(".//{*}VALUE"))
                    shares  = (info.find(".//{*}sshPrnamt") or info.find(".//{*}SSHPRNAMT"))
                    cls     = (info.find(".//{*}titleOfClass") or info.find(".//{*}TITLEOFCLASS"))
                    if name is not None and value is not None:
                        parsed.append({
                            "name":   (name.text or "").strip(),
                            "cusip":  (cusip.text or "").strip() if cusip is not None else "",
                            "class":  (cls.text or "").strip() if cls is not None else "",
                            "value":  int(value.text.replace(",","")) if value.text else 0,  # $천 단위
                            "shares": int(shares.text.replace(",","")) if shares is not None and shares.text else 0,
                        })
            if parsed:
                holdings = parsed
                break
        # 가치 기준 내림차순 정렬, 상위 N개
        holdings.sort(key=lambda x: x["value"], reverse=True)
        total_val = sum(h["value"] for h in holdings)
        result = []
        for h in holdings[:top_n]:
            pct = round(h["value"] / total_val * 100, 2) if total_val else 0
            result.append({
                "ticker": h.get("cusip") or "",  # SEC 13F XML은 보통 ticker 대신 CUSIP을 제공
                "name":   h["name"],
                "weight": pct,
                "shares": f"{h['shares']//10000}만주" if h['shares']>=10000 else f"{h['shares']:,}주",
                "value":  format_13f_value(h["value"]),
                "delta":  0,
                "trend":  "hold",
            })
        return {"top": result, "count": len(holdings), "total_value_thousand": total_val}
    except Exception as e:
        print(f"    ⚠ XML 파싱 오류: {e}")
        return {"top": [], "count": 0, "total_value_thousand": 0}

def get_13f_holdings(cik: str, accession: str, top_n: int = 15) -> list:
    """13F 보고서에서 상위 보유 종목 파싱"""
    return get_13f_report(cik, accession, top_n).get("top", [])

def fetch_nps_overseas_portfolio(limit: int = 120) -> list:
    """국민연금 해외 13F 포트폴리오 수집"""
    print("\n📡 [SEC] 국민연금 해외 13F 포트폴리오 수집 중...")
    try:
        acc, date = get_latest_13f_accession(NPS_13F_CIK)
        if not acc:
            print("  ⚠ 국민연금 13F 없음")
            return []
        report = get_13f_report(NPS_13F_CIK, acc, limit)
        rows = []
        for h in report.get("top", []):
            rows.append({
                **h,
                "exch": "US",
                "date": date,
            })
        print(f"  ✅ 국민연금 해외 13F: 전체 {report.get('count',0)}개 중 {len(rows)}개 표시, 신고일 {date}")
        return rows
    except Exception as e:
        print(f"  ⚠ 국민연금 해외 13F 수집 실패: {e}")
        return []

def fetch_global_whales(top_n: int = GLOBAL_WHALE_TOP_N) -> list:
    """전체 글로벌 고래 13F 데이터 수집"""
    print("\n📡 [D] SEC EDGAR 13F — 글로벌 고래 수집 중...")
    results = []
    for w in WHALES_13F:
        try:
            print(f"  → {w['name']} 조회 중...", end=" ")
            acc, date = get_latest_13f_accession(w["cik"])
            if not acc:
                print("13F 없음")
                continue
            report = get_13f_report(w["cik"], acc, top_n)
            holdings = report.get("top", [])
            total_val = report.get("total_value_thousand", 0)
            results.append({
                "id":       w["cik"],
                "emoji":    w["emoji"],
                "name":     w["name"],
                "fund":     w["name"],
                "aum":      format_13f_value(total_val),
                "holdings": report.get("count", len(holdings)),
                "filingDate": date,
                "top":      holdings,
            })
            print(f"✅ 전체 {report.get('count',0)}개 중 {len(holdings)}개 표시, 신고일 {date}")
            time.sleep(0.5)  # SEC rate limit 준수
        except Exception as e:
            print(f"오류: {e}")
    print(f"  ✅ 글로벌 고래 {len(results)}개 기관 수집 완료")
    return results

# ──────────────────────────────────────────────────────
#  글로벌 고래 실행 함수
# ──────────────────────────────────────────────────────

def run_global_whales(auto: bool = False):
    print("\n" + "═"*52)
    print("  🌍 SEC 13F — 글로벌 고래 포트폴리오 수집")
    print("═"*52)
    whales = fetch_global_whales(top_n=GLOBAL_WHALE_TOP_N)
    out = {
        "data_updated_at": TODAY.isoformat(),
        "global_whales": whales,
        "meta": {
            "schedule": "SEC 13F 분기 공시 기준, GitHub Actions 매일 10:00 KST 확인",
            "top_n": GLOBAL_WHALE_TOP_N,
        },
    }
    with open("global_whales.json","w",encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n  💾 global_whales.json 저장 완료 ({len(whales)}개 기관)")

    if auto or Path(FB_CRED_FILE).exists() or FB_SERVICE_ACCOUNT_JSON:
        print("  ☁  Firebase 자동 업로드 중...")
        # whale_data에 병합 업로드
        if upload_to_firebase("whale_data", "global", out):
            print("  ✅ 글로벌 고래 데이터 반영 완료!")
    else:
        print("  💡 global_whales.json → 관리자 패널에서 업로드하거나")
        print("     Firestore에 'whale_data/global' 컬렉션으로 저장하세요.")


if __name__ == "__main__":
    args = sys.argv[1:]
    auto = "--auto" in args
    do_dart = "--dart" in args or not [a for a in args if a.startswith("--")]
    do_kis  = "--kis"  in args

    # --auto 는 DART만 (GitHub Actions용)
    if auto:
        do_dart = True
        do_kis  = False

    print("╔══════════════════════════════════════════════════╗")
    print("║   🐋 Whale Tracker Pro — 데이터 수집기            ║")
    print(f"║   {TODAY.strftime('%Y-%m-%d %H:%M')}                                ║")
    print("║   모드: " + ("자동(GitHub Actions)" if auto else "수동") + " " * 30 + "║")
    print("╚══════════════════════════════════════════════════╝")

    if do_dart:
        try:
            run_dart(auto=auto)
        except Exception as e:
            print(f"\n  ❌ DART 오류: {e}")

    if do_kis:
        run_kis()

    print("\n" + "═"*52)
    print("  🎉 완료!")
    print("═"*52)
