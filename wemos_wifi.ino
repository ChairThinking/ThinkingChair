#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>

const char* ssid = "id";       // 와이파이 이름
const char* password = "pw"; // 와이파이 비밀번호

// 1단계에서 얻은 본인의 서버 URL로 반드시 교체하세요!
const char* serverUrl = "https://f5rvb6lfeoys4jk2a2a32z7ufy0iubkl.lambda-url.ap-northeast-2.on.aws/";

void setup() {
  Serial.begin(9600); // 아두이노와의 통신용
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected! Wemos is Ready.");
}

void loop() {
  if (Serial.available() > 0) {
    String uid = Serial.readStringUntil('\n');
    uid.trim();
    Serial.print("Received from Arduino: ");
    Serial.println(uid);
    sendDataToAWS(uid);
  }
}

void sendDataToAWS(String uid) {
  if (WiFi.status() == WL_CONNECTED) {
    WiFiClient client;
    HTTPClient http;
    http.begin(client, serverUrl);
    http.addHeader("Content-Type", "application/json");
    String jsonPayload = "{\"uid\":\"" + uid + "\"}";
    int httpCode = http.POST(jsonPayload);
    if(httpCode > 0) {
        String payload = http.getString();
        Serial.print("HTTP Response code: ");
        Serial.println(httpCode);
        Serial.print("Response payload: ");
        Serial.println(payload);
    } else {
        Serial.print("Error on sending POST: ");
        Serial.println(httpCode);
    }
    http.end();
  }
}
