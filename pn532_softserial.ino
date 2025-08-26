#include <Wire.h>
#include <Adafruit_PN532.h>
#include <SoftwareSerial.h> // 가상 시리얼 통신 라이브러리 추가

// Wemos D1 R2와 통신할 가상 시리얼 포트 설정 (RX, TX)
SoftwareSerial wemosSerial(10, 11); 

#define PN532_IRQ   2
#define PN532_RESET 3
Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET);

void setup(void) {
  Serial.begin(115200); // PC와의 통신용 (디버깅)
  wemosSerial.begin(9600); // Wemos와의 통신용 (속도는 맞춰주기만 하면 됨)

  Serial.println("PN532 NFC I2C test for Arduino Uno");
  nfc.begin();
  
  // ... (기존 setup 코드와 동일) ...

  nfc.SAMConfig();
  Serial.println("Waiting for an ISO14443A Card ...");
}

void loop(void) {
  uint8_t success;
  uint8_t uid[] = { 0, 0, 0, 0, 0, 0, 0 };
  uint8_t uidLength;

  success = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength);

  if (success) {
    Serial.println("Found a card!");
    Serial.print("UID Value: ");
    nfc.PrintHex(uid, uidLength);
    Serial.println();

    // UID를 문자열로 변환
    String uidString = "";
    for (int i=0; i < uidLength; i++) {
      if (uid[i] < 0x10) uidString += "0"; // 1자리 16진수 앞에 0 붙이기
      uidString += String(uid[i], HEX);
    }
    uidString.toUpperCase();

    // Wemos D1 R2로 UID 문자열 전송
    wemosSerial.println(uidString);
    Serial.print("Sent to Wemos: ");
    Serial.println(uidString);
    
    delay(2000); // 2초 대기
  }
}
