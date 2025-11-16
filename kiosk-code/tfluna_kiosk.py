#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
tfluna_kiosk.py — TF-Luna → Kiosk WebSocket (cooldown 기반 재감지)

- 사용자가 가까이 오면 1회만 세션 시작 트리거(lidarDistance) 전송
- 세션 진행 중에는 재트리거 안 함
- 결제/세션 종료 이벤트(sessionEnded/goHome) 후에는
  일정 시간(cooldown) 동안은 다시 감지하지 않음
- restart 없이도, END + 쿨다운 이후에는 항상 다시 감지되도록 설계
"""

import os
import sys
import time
import json
import threading
import serial
from websocket import create_connection, WebSocketConnectionClosedException

# ======================= 환경변수/설정 =======================
PORT                = os.environ.get("LIDAR_PORT", "/dev/ttyAMA0")
BAUDRATE            = int(os.environ.get("LIDAR_BAUD", "115200"))
THRESHOLD_CM        = int(os.environ.get("LIDAR_THRESH_CM", "100"))
WS_SERVER           = os.environ.get("WS_SERVER", "ws://127.0.0.1:3000")

# 결제/세션 종료 후 쿨다운(초)
COOLDOWN_AFTER_END_SEC = float(os.environ.get("LIDAR_COOLDOWN_AFTER_END", "5.0"))

# 프로젝트 안 'websocket' 폴더/모듈과 이름 충돌 방지
CONFLICT = "/home/pi/Desktop/kiosk - update/websocket"
sys.path = [p for p in sys.path if CONFLICT not in p]

# 서버 이벤트 매핑
START_EVENTS = {"startVision", "sessionStarted"}   # ← 이제 상태는 안 바꿈 (로그만)
END_EVENTS   = {"sessionEnded", "goHome"}

# ======================= 공유 상태 =======================
session_active = False     # 현재 손님 세션 진행 중인가? (사용자 감지 이후 END 오기 전까지)
session_armed  = True      # 새 손님 감지를 받을 준비가 되었는가?
cooldown_until = 0.0       # END 이후 쿨다운이 끝나는 시각(초)

lock = threading.Lock()

# ======================= WebSocket 유틸 =======================
def connect_ws():
  """서버와 연결. 실패 시 재시도."""
  global session_active, session_armed, cooldown_until
  while True:
    try:
      ws = create_connection(WS_SERVER, timeout=3)
      ws.settimeout(None)
      with lock:
        # 연결 새로 될 때마다 깔끔하게 초기화
        session_active = False
        session_armed  = True
        cooldown_until = 0.0
      print("✅ WS connected (state reset: active=False, armed=True)")
      return ws
    except Exception as e:
      print("WS connect retry:", e)
      time.sleep(1.0)

def safe_send(ws, obj):
  data = json.dumps(obj, ensure_ascii=False)
  while True:
    try:
      ws.send(data)
      return ws
    except (WebSocketConnectionClosedException, BrokenPipeError, OSError):
      ws = connect_ws()
    except Exception as e:
      print("WS send error:", e)
      time.sleep(0.5)

def ws_recv_loop(ws):
  """서버 → 클라이언트 이벤트 수신하여 세션 상태 갱신."""
  global session_active, session_armed, cooldown_until
  while True:
    try:
      msg = ws.recv()
      if not msg:
        raise Exception("peer closed")
      try:
        data = json.loads(msg)
      except Exception:
        continue

      kind = data.get("type") or data.get("action")
      if not kind:
        continue

      now = time.time()
      with lock:
        # startVision / sessionStarted 는 이제 상태 안 건드리고 그냥 로그만
        if kind in START_EVENTS:
          print(f"🟡 서버 이벤트 수신(start) (상태 변경 없음) → active={session_active}, armed={session_armed}")
          continue

        # 명시적 종료: 쿨다운 시작
        if kind in END_EVENTS:
          session_active = False
          session_armed  = False
          cooldown_until = now + COOLDOWN_AFTER_END_SEC
          print(
            f"🔵 서버 이벤트 수신(END) → active={session_active}, armed={session_armed}, "
            f"cooldown_until={cooldown_until:.1f}"
          )
          continue

        # sessionOpen 은 “새 라운드 준비됨” 알림.
        # 쿨다운이 끝났으면 바로 무장, 아니면 쿨다운 유지
        if kind == "sessionOpen":
          if now >= cooldown_until:
            session_active = False
            session_armed  = True
          print(f"🟣 sessionOpen 수신 → active={session_active}, armed={session_armed}")
          continue

    except Exception as e:
      print("WS recv error:", e)
      try:
        ws.close()
      except:
        pass
      ws = connect_ws()

# ======================= TF-Luna 파싱 =======================
def parse_tfluna_frame(ser):
  """TF-Luna 프레임 하나 파싱 → 거리(cm) 또는 None"""
  if ser.read(1) != b'\x59':
    return None
  if ser.read(1) != b'\x59':
    return None
  rest = ser.read(7)
  if len(rest) < 7:
    return None
  distance = rest[0] + rest[1] * 256
  return distance

# ======================= 메인 루프 =======================
def main():
  global session_active, session_armed, cooldown_until

  ws = connect_ws()
  t = threading.Thread(target=ws_recv_loop, args=(ws,), daemon=True)
  t.start()

  ser = serial.Serial(PORT, baudrate=BAUDRATE, timeout=0.1)
  time.sleep(0.5)
  ser.reset_input_buffer()

  while True:
    try:
      d = parse_tfluna_frame(ser)
      if d is None:
        continue

      near = (d <= THRESHOLD_CM)

      with lock:
        now = time.time()

        # 1) 세션 진행 중이면(사용자 이미 감지된 상태) 추가 감지 무시
        if session_active:
          time.sleep(0.02)
          continue

        # 2) 세션은 끝났지만, END 이후 쿨다운 구간이면 감지 무시
        if now < cooldown_until:
          session_armed = False
          time.sleep(0.02)
          continue
        else:
          # 쿨다운 끝 → 다음 손님 대기
          if not session_armed:
            print("🔄 쿨다운 종료 → 다음 손님 대기(armed=True)")
          session_armed = True

        # 3) 실제 트리거
        if near and session_armed:
          print(f"🟢 사용자 감지됨! 거리: {d}cm → 키오스크 화면 실행")
          ws = safe_send(ws, {"action": "lidarDistance", "distance": int(d)})

          # 이 시점부터는 END 이벤트가 올 때까지 재감지 금지
          session_active = True
          session_armed  = False

      time.sleep(0.02)

    except KeyboardInterrupt:
      break
    except Exception as e:
      print("Loop error:", e)
      time.sleep(0.2)

if __name__ == "__main__":
  main()
