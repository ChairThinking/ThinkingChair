#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>

// ===== WiFi =====
const char* ssid = "";
const char* password = "";

// ===== (기존) 태그 기록 서버 =====
static const char* TAG_URL = "http://13.209.14.101:8080/api/tag";

// ===== 결제 서버 설정 =====
static const char* KIOSK_ID   = "KIOSK-01";
static const char* API_BASE   = "http://13.209.14.101:4000/api";
static const bool  RECORD_TAG = false;   // 태그 수집 서버가 자주 실패하니 false 유지 권장

// ===== 세션코드/타임스탬프 캐시 (★ 추가) =====
String gSessionCode = "";      // 최근 "열린" 세션코드
String gSessionAt   = "";      // 최근 세션의 created_at(서버가 주는 문자열)
unsigned long lastFetchMs = 0;
const unsigned long FETCH_INTERVAL_MS = 5000;

// ===== 유틸 선언 =====
String normalizeUid(const String& raw);
String httpGet(const String& url);
int    httpPostJson(const String& url, const String& json, String& respBody);
String extractJsonStringValue(const String& json, const String& key);
bool   isOpenStatus(const String& s);         // ★ 추가
bool   isNewerOrEqualTs(const String& a, const String& b); // ★ 추가
void   fetchCurrentSessionCode();   // 세션코드 갱신
void   sendTagToCollector(const String& uid);
void   sendUidToBindEvent(const String& uid);

void setup() {
  Serial.begin(9600);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected! Wemos is Ready.");
}

void loop() {
  // 1) 주기적으로 "열린 세션" 코드 동기화
  unsigned long now = millis();
  if (WiFi.status() == WL_CONNECTED && (now - lastFetchMs >= FETCH_INTERVAL_MS)) {
    lastFetchMs = now;
    fetchCurrentSessionCode();
  }

  // 2) 리더로부터 UID 입력 처리
  if (Serial.available() > 0) {
    String uid = Serial.readStringUntil('\n');
    uid.trim();
    String norm = normalizeUid(uid);

    Serial.print("UID: ");
    Serial.println(norm);

    // (선택) 태그 수집 서버로 전송 (실패해도 결제 흐름과 무관)
    sendTagToCollector(norm);

    // 결제 세션으로 바인딩
    sendUidToBindEvent(norm);
  }
}

// ========== 네트워킹 헬퍼 ==========
String httpGet(const String& url) {
  WiFiClient client;
  HTTPClient http;
  String body = "";

  if (!http.begin(client, url)) {
    Serial.println("[GET] begin() fail");
    return body;
  }

  int code = http.GET();
  Serial.print("[GET] "); Serial.print(url); Serial.print(" -> code="); Serial.println(code);
  if (code > 0) body = http.getString();
  http.end();
  return body;
}

int httpPostJson(const String& url, const String& json, String& respBody) {
  WiFiClient client;
  HTTPClient http;
  respBody = "";

  if (!http.begin(client, url)) {
    Serial.println("[POST] begin() fail");
    return -1000;
  }
  http.addHeader("Content-Type", "application/json");

  Serial.print("[POST] "); Serial.println(url);
  Serial.print("[BODY] "); Serial.println(json);

  int code = http.POST(json);
  if (code > 0) respBody = http.getString();

  Serial.print("[RESP CODE] "); Serial.println(code);
  Serial.print("[RESP BODY] "); Serial.println(respBody);

  http.end();
  return code;
}

// ========== 유틸 ==========
String normalizeUid(const String& raw) {
  String s = raw;
  s.trim();
  s.replace("0x", ""); s.replace("0X", "");
  while (s.indexOf(' ') >= 0) s.remove(s.indexOf(' '), 1);
  s.toUpperCase();
  return s;
}

// "key":"value" 추출 (쌍따옴표 기준 단순 파서)
String extractJsonStringValue(const String& json, const String& key) {
  String pat = String("\"") + key + String("\":\"");
  int start = json.indexOf(pat);
  if (start < 0) return "";
  start += pat.length();
  int end = json.indexOf("\"", start);
  if (end < 0) return "";
  return json.substring(start, end);
}

// ★ 열린 상태만 인정
bool isOpenStatus(const String& s) {
  return (s == "SCANNING" || s == "READY" || s == "OPEN");
}

// ★ 타임스탬프 비교 (서버 created_at이 ISO-8601 같은 문자열이면 사전식 비교로도 충분한 경우가 많음)
//    형식 불확실하면, 단순히 길이가 같고 사전순 비교로 처리.
bool isNewerOrEqualTs(const String& a, const String& b) {
  if (a.length() == 0) return false;
  if (b.length() == 0) return true; // 기존이 없으면 새 값 채택
  // 길이 다르면 길이 긴 쪽을 우선(대충 방어). 일반적으로 동일 형식이면 길이 동일.
  if (a.length() != b.length()) return (a.length() > b.length());
  return (a >= b); // 사전식: a가 더 최신(같거나 큼)
}

// ========== 동작 로직 ==========
// ★ open-latest 응답에서 status/created_at까지 확인하고, 열린 상태 & 더 최신일 때만 갱신
void fetchCurrentSessionCode() {
  String url = String(API_BASE) + "/purchase-sessions/open-latest?kiosk_id=" + String(KIOSK_ID);
  String body = httpGet(url);
  if (body.length() == 0) return;

  // 404면 NO_OPEN_SESSION일 수 있음 → 기존 세션 유지
  if (body.indexOf("NO_OPEN_SESSION") >= 0) {
    Serial.println("[session] NO_OPEN_SESSION (keep current)");
    return;
  }

  String code = extractJsonStringValue(body, "session_code");
  String st   = extractJsonStringValue(body, "status");       // ★
  String at   = extractJsonStringValue(body, "created_at");   // ★

  Serial.print("[session] probe code="); Serial.print(code);
  Serial.print(" status="); Serial.print(st);
  Serial.print(" created_at="); Serial.println(at);

  if (code.length() == 0) return;

  // 열린 상태만 채택
  if (!isOpenStatus(st)) {
    Serial.println("[session] skip (not OPEN state)");
    return;
  }

  // 더 최신(created_at)일 때만 교체
  if (code != gSessionCode && isNewerOrEqualTs(at, gSessionAt)) {
    gSessionCode = code;
    gSessionAt   = at;
    Serial.print("[session] updated: "); Serial.println(gSessionCode);
  } else {
    Serial.print("[session] keep: "); Serial.println(gSessionCode.length() ? gSessionCode : "(none)");
  }
}

void sendTagToCollector(const String& uid) {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!TAG_URL || String(TAG_URL).length() == 0) return;

  String payload = String("{\"uid\":\"") + uid + "\"}";
  String resp;
  int httpCode = httpPostJson(TAG_URL, payload, resp);
  Serial.print("[tag] code="); Serial.print(httpCode);
  Serial.print(" resp="); Serial.println(resp);
}

void sendUidToBindEvent(const String& uid) {
  if (WiFi.status() != WL_CONNECTED) return;

  if (gSessionCode.length() < 4) {
    Serial.println("[bind] no session_code cached. skip.");
    return;
  }

  String url  = String(API_BASE) + "/purchase-sessions/" + gSessionCode + "/bind-card-event";
  String body = String("{\"uid\":\"") + uid + "\",\"record_tag\":" + (RECORD_TAG ? "true" : "false") + "}";
  String resp;
  int code = httpPostJson(url, body, resp);

  Serial.println("==== BIND CARD ====");
  Serial.print("[bind] UID="); Serial.println(uid);
  Serial.print("[bind] POST "); Serial.println(url);
  Serial.print("[bind] code="); Serial.println(code);
  Serial.print("[bind] resp="); Serial.println(resp);
}
