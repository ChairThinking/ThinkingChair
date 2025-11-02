"""
tfluna_kiosk.py — TF-Luna → Kiosk WebSocket (session-aware gating, hard-lock)
- 세션 진행 중에는 재감지(재무장) 금지
- 서버가 보내는 이벤트(startVision/sessionStarted, goHome/sessionEnded)를 수신해 무장/재무장 제어
- scanComplete/stopVision 은 '중간 단계'로 보고 종료로 취급하지 않음
- 첫 감지 후 최소 N초 하드락(명시 종료가 오기 전에는 절대 재무장 금지)
- 서버가 꺼져 있거나 이벤트를 못 받는 경우에만 (옵션) away-timeout 폴백으로 재무장
- 필요 패키지: pip install websocket-client pyserial
"""

import os
import sys
import time
import json
import threading
import serial
from websocket import create_connection, WebSocketConnectionClosedException

# ======================= 환경변수/설정 =======================
PORT                = os.environ.get("LIDAR_PORT", "/dev/ttyAMA0")  # /dev/ttyUSB0 등 환경에 맞게
BAUDRATE            = int(os.environ.get("LIDAR_BAUD", "115200"))
THRESHOLD_CM        = int(os.environ.get("LIDAR_THRESH_CM", "100"))  # 감지 임계 거리
WS_SERVER           = os.environ.get("WS_SERVER", "ws://127.0.0.1:3000")

# 하드락: 첫 감지 후 최소 이 시간 동안은 어떤 경우에도 재무장 금지
ACTIVE_HARD_LOCK_SEC = float(os.environ.get("LIDAR_ACTIVE_LOCK", "15.0"))

# 오프라인 폴백(서버 이벤트를 한번도 못 받았을 때만 사용)
OFFLINE_FALLBACK_ENABLE = os.environ.get("LIDAR_OFFLINE_FALLBACK", "1") == "1"
REARM_AFTER_AWAY_SEC    = float(os.environ.get("LIDAR_AWAY_REARM", "2.0"))

# 프로젝트 안 'websocket' 폴더/모듈과 이름 충돌 방지 (필요시 경로 조정)
CONFLICT = "/home/pi/Desktop/kiosk - update/websocket"
sys.path = [p for p in sys.path if CONFLICT not in p]

# 서버 이벤트 매핑
START_EVENTS = {"startVision", "sessionStarted"}       # 세션 시작/진행
END_EVENTS   = {"sessionEnded", "goHome"}              # 세션 종료/대기화면 복귀 (scanComplete/stopVision 제외!)

# ======================= 공유 상태 =======================
session_active = False     # 세션 진행 중?
session_armed  = True      # 트리거 가능? (근접 시 1회만 전송)
server_seen    = False     # 서버 이벤트를 한 번이라도 받았는가(오프라인 판단)
first_hit_ts   = None      # 최초 감지 시간(하드락 기준)
last_far_ts    = None      # 폴백용: 멀어진 시간 기록
lock           = threading.Lock()

# ======================= WebSocket 유틸 =======================
def connect_ws():
    """서버와 연결. 실패 시 재시도."""
    while True:
        try:
            ws = create_connection(WS_SERVER, timeout=3)
            ws.settimeout(None)  # recv 무기한 대기
            print("✅ WS connected")
            return ws
        except Exception as e:
            print("WS connect retry:", e)
            time.sleep(1.0)

def safe_send(ws, obj):
    """전송 중 끊기면 자동 재연결 후 재시도."""
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
    global session_active, session_armed, server_seen, first_hit_ts
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

            with lock:
                server_seen = True
                if kind in START_EVENTS:
                    # 세션 시작/진행: 재감지 금지(= 락)
                    session_active = True
                    session_armed  = True
                    first_hit_ts is None
                    print(f"🟡 서버 이벤트 수신(start) → session_active={session_active}, session_armed={session_armed}")
                elif kind in END_EVENTS:
                    # 명시적 종료: 다음 손님 대기(재무장)
                    session_active = False
                    session_armed  = True
                    first_hit_ts   = None         # 하드락 해제
                    print(f"🔵 서버 이벤트 수신 → session_active={session_active}, session_armed={session_armed}")

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
    global session_active, session_armed, server_seen, first_hit_ts, last_far_ts

    ws = connect_ws()
    # 서버 수신 스레드 시작
    t = threading.Thread(target=ws_recv_loop, args=(ws,), daemon=True)
    t.start()

    # 라이다 연결
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
                # ── 세션 진행 중: 재감지 절대 금지 ──
                if session_active:
                    # 하드락 적용: 명시적 종료가 오지 않더라도 최소 N초는 감지 금지
                    if first_hit_ts and (time.time() - first_hit_ts) < ACTIVE_HARD_LOCK_SEC:
                        last_far_ts = None
                        time.sleep(0.02)
                        continue
                    # 하드락이 끝났더라도, 종료 이벤트(END_EVENTS) 없이는 재무장 금지
                    last_far_ts = None
                    time.sleep(0.02)
                    continue

                # ── 세션 비활성 상태: 트리거 가능 ──
                if near and session_armed:
                    print(f"🟢 사용자 감지됨! 거리: {d}cm → 키오스크 화면 실행")
                    ws = safe_send(ws, {"action": "lidarDistance", "distance": int(d)})

                    # 트리거 후: 임시로 세션 진행 상태로 전환(서버 이벤트 대기)
                    session_armed  = False
                    session_active = True
                    first_hit_ts   = time.time()   # 하드락 시작
                    last_far_ts    = None

                # ── 오프라인 폴백 (서버 이벤트를 한 번도 못 받았을 때만) ──
                if OFFLINE_FALLBACK_ENABLE and not server_seen:
                    if not near:
                        if last_far_ts is None:
                            last_far_ts = time.time()
                        elif (time.time() - last_far_ts) >= REARM_AFTER_AWAY_SEC:
                            # 다음 손님 대기(폴백)
                            if not session_armed:
                                print("🔄 다음 손님 대기 (offline fallback)")
                            session_active = False
                            session_armed  = True
                            first_hit_ts   = None
                    else:
                        last_far_ts = None
                else:
                    # 서버를 쓰는 경우엔 종료 이벤트로만 재무장 (여기선 폴백 타이머 사용 안 함)
                    last_far_ts = None if near else last_far_ts

            time.sleep(0.02)  # ~50Hz loop

        except KeyboardInterrupt:
            break
        except Exception as e:
            print("Loop error:", e)
            time.sleep(0.2)

if __name__ == "__main__":
    main()