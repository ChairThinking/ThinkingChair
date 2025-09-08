#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>

// ===== WiFi =====
const char* ssid = "";          // 와이파이 이름
const char* password = "";      // 와이파이 비밀번호

// ===== (기존) 태그 기록 서버 =====
static const char* TAG_URL = "http://43.201.105.163:8080/api/tag";

// ===== 결제 서버 설정 =====
static const char* KIOSK_ID   = "KIOSK-01"; // 이 장치가 소속된 키오스크 ID
static const char* API_BASE   = "http://43.201.105.163:4000/api";
static const bool  RECORD_TAG = false;       // 바인딩 시 tags에도 같이 기록

// ===== 세션코드 캐시 =====
String gSessionCode = "";                    // 최근 OPEN 세션코드 캐시
unsigned long lastFetchMs = 0;
const unsigned long FETCH_INTERVAL_MS = 5000; // 5초마다 확인

// ===== 유틸 선언 =====
String normalizeUid(const String& raw);
String httpGet(const String& url);
int    httpPostJson(const String& url, const String& json, String& respBody);
String extractJsonStringValue(const String& json, const String& key);
void   fetchCurrentSessionCode();   // 세션코드 갱신
void   sendTagToCollector(const String& uid);
void   sendUidToBindEvent(const String& uid);

void setup() {
  Serial.begin(9600); // 아두이노 보드와 시리얼 통신
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

  // 2) 아두이노(리더)로부터 UID 입력 처리
  if (Serial.available() > 0) {
    String uid = Serial.readStringUntil('\n');
    uid.trim();
    String norm = normalizeUid(uid);

    Serial.print("UID: ");
    Serial.println(norm);

    // (기존) 태그 수집 서버로 전송
    sendTagToCollector(norm);

    // (신규) 결제 세션으로 바인딩
    sendUidToBindEvent(norm);
  }
}

// ========== 네트워킹 헬퍼 ==========
String httpGet(const String& url) {
  WiFiClient client;
  HTTPClient http;
  String body = "";
  if (!http.begin(client, url)) return body;

  int code = http.GET();
  if (code > 0) body = http.getString();
  http.end();
  return body;
}

int httpPostJson(const String& url, const String& json, String& respBody) {
  WiFiClient client;
  HTTPClient http;
  respBody = "";

  if (!http.begin(client, url)) return -1000;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(json);
  if (code > 0) respBody = http.getString();
  http.end();
  return code;
}

// ========== 유틸 ==========
String normalizeUid(const String& raw) {
  String s = raw;
  s.trim();
  s.replace("0x", "");
  s.replace("0X", "");
  while (s.indexOf(' ') >= 0) s.remove(s.indexOf(' '), 1);
  s.toUpperCase();
  return s;
}

// 아주 단순한 JSON 파서: "key":"value" 형태만 추출
String extractJsonStringValue(const String& json, const String& key) {
  String pat = String("\"") + key + String("\":\"");
  int start = json.indexOf(pat);
  if (start < 0) return "";
  start += pat.length();
  int end = json.indexOf("\"", start);
  if (end < 0) return "";
  return json.substring(start, end);
}

// ========== 동작 로직 ==========
void fetchCurrentSessionCode() {
  String url = String(API_BASE) + "/purchase-sessions/open-latest?kiosk_id=" + String(KIOSK_ID);
  String body = httpGet(url);

  if (body.length() == 0) {
    // 네트워크 오류 등
    return;
  }

  // 404일 때 서버는 보통 {"message":"NO_OPEN_SESSION"} 같은 걸 줄 것.
  // session_code가 있으면 갱신
  String code = extractJsonStringValue(body, "session_code");
  if (code.length() > 0 && code != gSessionCode) {
    gSessionCode = code;
    Serial.print("[session] updated: ");
    Serial.println(gSessionCode);
  }
}

void sendTagToCollector(const String& uid) {
  if (WiFi.status() != WL_CONNECTED) return;
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

  Serial.print("[bind] POST "); Serial.println(url);
  Serial.print("[bind] code="); Serial.println(code);
  Serial.print("[bind] resp="); Serial.println(resp);
}
