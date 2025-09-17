#!/usr/bin/env python3
import asyncio, json, time, os, shutil, subprocess
from datetime import datetime
import numpy as np
import websockets

# ===== 설정 =====
WS_URL          = os.environ.get("KIOSK_WS", "ws://localhost:3000")

# 캡처 파라미터 (rpicam-vid 출력 해상도/FPS와 동일해야 함)
W               = int(os.environ.get("W", "320"))
H               = int(os.environ.get("H", "240"))
FPS             = int(os.environ.get("FPS", "15"))

# 카메라 안정화(조명 플리커/AE 흔들림 감소)
SHUTTER_US      = os.environ.get("SHUTTER_US", "16666")  # 60Hz=16666, 50Hz=20000
GAIN            = os.environ.get("GAIN", "1.0")
AWBGAINS        = os.environ.get("AWBGAINS", "1.0,1.0")

# 정지 감지 파라미터 (우선 동작 확인 → 나중에 낮추기)
DOWNSCALE       = int(os.environ.get("DOWNSCALE", "2"))
WARMUP_FRAMES   = int(os.environ.get("WARMUP_FRAMES", "8"))
ENTER_GRACE_MS  = int(os.environ.get("ENTER_GRACE_MS", "800"))
STABLE_MS       = int(os.environ.get("STABLE_MS", "1000"))
SAMPLE_INTERVAL = float(os.environ.get("SAMPLE_INTERVAL", "0.08"))
DIFF_THRESHOLD  = float(os.environ.get("DIFF_THRESHOLD", "80.0"))  # 초기엔 크게, 나중에 8~12로

USE_ROI         = os.environ.get("USE_ROI", "1") == "1"
ROI_RATIO       = float(os.environ.get("ROI_RATIO", "0.6"))        # 중앙 60% 기본
USE_BLUR        = os.environ.get("USE_BLUR", "1") == "1"

AUTO_START      = os.environ.get("AUTO_START", "1") == "1"
FALLBACK_SEC    = float(os.environ.get("FALLBACK_SEC", "3"))
DEBUG           = os.environ.get("DEBUG", "1") == "1"
PRINT_EVERY     = int(os.environ.get("PRINT_EVERY", "5"))

# ===== rpicam-vid (YUV420 raw) 서브프로세스 =====
def start_yuv_pipe():
    if shutil.which("rpicam-vid") is None:
        print("❌ rpicam-vid 미설치/경로 오류")
    cmd = [
        "rpicam-vid",
        "-t", "0",
        "--width", str(W),
        "--height", str(H),
        "--framerate", str(FPS),
        "--codec", "yuv420",           # YUV420 원시 프레임
        # "--inline",                   # ❌ H.264 전용, 제거
        # "--awb", "off",               # ❌ 현재 rpicam-vid에서 invalid, 제거
        # "--awbgains", AWBGAINS,       # (AWB auto면 의미 없음, 필요 시 수동 모드에서만)
        "--shutter", SHUTTER_US,
        "--gain", GAIN,
        "--denoise", "off",
        "-o", "-"                      # stdout
    ]
    print("▶️ rpicam-vid (raw YUV420) 시작:", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    print(f"✅ rpicam-vid PID={proc.pid}")
    return proc

def stop_yuv_pipe(proc):
    print("⏹ rpicam-vid 종료 시도")
    try:
        proc.terminate()
        proc.wait(timeout=1)
    except Exception:
        try: proc.kill()
        except Exception: pass
    print("✅ 파이프 종료")

# YUV420p 한 프레임 크기 (Y:W*H, U:W*H/4, V:W*H/4)
FRAME_BYTES = int(W * H * 3 / 2)

def read_exact(pipe, nbytes):
    """stdout에서 정확히 nbytes 읽어오기 (부족하면 None)"""
    buf = b""
    while len(buf) < nbytes:
        chunk = pipe.read(nbytes - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf

def yuv420_to_gray_down(buf):
    """
    rpicam-vid --codec yuv420 가 내보낸 한 프레임(buf)에서
    Y 평면만 뽑아 다운샘플링하여 float32(gray)로 반환
    """
    # Y plane: 앞쪽 W*H 바이트
    y_plane = np.frombuffer(buf, dtype=np.uint8, count=W*H, offset=0).reshape((H, W))
    gray = y_plane.astype(np.float32)
    if DOWNSCALE > 1:
        gray = gray[::DOWNSCALE, ::DOWNSCALE]
    # ROI
    if USE_ROI:
        h, w = gray.shape
        rx = int(w * (1.0 - ROI_RATIO) / 2)
        ry = int(h * (1.0 - ROI_RATIO) / 2)
        gray = gray[ry:h-ry, rx:w-rx]
    # Blur
    if USE_BLUR:
        # 간단한 3x3 평균(가우시안 없이)로 노이즈만 소폭 억제
        k = np.array([[1,1,1],[1,1,1],[1,1,1]], dtype=np.float32) / 9.0
        # 패딩 후 컨볼루션 (가벼운 구현)
        from numpy.lib.stride_tricks import sliding_window_view
        if gray.shape[0] >= 3 and gray.shape[1] >= 3:
            win = sliding_window_view(gray, (3,3))
            gray = (win * k).sum(axis=(-1,-2))
    return gray

# ===== 정지 감지 루프 =====
async def stillness_detect_and_signal(ws_send):
    proc = start_yuv_pipe()
    miss = 0
    try:
        prev = None
        frames = 0
        entered_ms = time.time() * 1000.0
        stable_start_ms = None

        while True:
            buf = read_exact(proc.stdout, FRAME_BYTES)
            if buf is None:
                miss += 1
                if miss % 5 == 0:
                    # stderr 한 줄만 비워서 에러 힌트 보기
                    try:
                        line = proc.stderr.readline().decode(errors="ignore").strip()
                        if line:
                            print("rpicam-vid:", line)
                    except Exception:
                        pass
                if miss >= 20:
                    print("♻️ rpicam-vid 재시작")
                    stop_yuv_pipe(proc)
                    proc = start_yuv_pipe()
                    miss = 0
                await asyncio.sleep(0.02)
                continue
            miss = 0

            gray = yuv420_to_gray_down(buf)

            # 워밍업
            if frames < WARMUP_FRAMES:
                prev = gray; frames += 1
                if DEBUG:
                    print(f"[warmup] {frames}/{WARMUP_FRAMES}")
                await asyncio.sleep(SAMPLE_INTERVAL); continue

            if prev is None:
                prev = gray
                await asyncio.sleep(SAMPLE_INTERVAL); continue

            diff = float(np.mean(np.abs(gray - prev)))  # 0..255
            prev = gray

            now_ms = time.time() * 1000.0
            in_grace = (now_ms - entered_ms) < ENTER_GRACE_MS

            if DEBUG and (frames % PRINT_EVERY == 0):
                sfor = 0 if not stable_start_ms else int(now_ms - stable_start_ms)
                print(f"[diff] {diff:.1f} grace={in_grace} stable_for={sfor}ms thr={DIFF_THRESHOLD}")

            if not in_grace and diff <= DIFF_THRESHOLD:
                if stable_start_ms is None:
                    stable_start_ms = now_ms
                    if DEBUG: print("… 정지 후보 시작")
                elif (now_ms - stable_start_ms) >= STABLE_MS:
                    print("✅ STILL: basketStable emit")
                    await ws_send({"type":"basketStable","ts":datetime.utcnow().isoformat()})
                    break
            else:
                if stable_start_ms is not None and DEBUG:
                    print("↩️ 정지 후보 리셋")
                stable_start_ms = None

            frames += 1
            await asyncio.sleep(SAMPLE_INTERVAL)
    finally:
        stop_yuv_pipe(proc)

# ===== WebSocket =====
async def ws_client():
    async with websockets.connect(WS_URL, ping_interval=20, ping_timeout=20) as ws:
        print("✅ Stillness WS connected:", WS_URL)
        cam_task = None

        async def ws_send(obj):
            await ws.send(json.dumps(obj))

        if AUTO_START and ((not cam_task) or cam_task.done()):
            print("🟢 AUTO_START=1 → 정지 감지 즉시 시작")
            cam_task = asyncio.create_task(stillness_detect_and_signal(ws_send))

        async def fallback():
            await asyncio.sleep(FALLBACK_SEC)
            if (not cam_task) or cam_task.done():
                print(f"⏱ sessionStarted 미수신({FALLBACK_SEC:.0f}s) → 폴백 자동 시작")
                return asyncio.create_task(stillness_detect_and_signal(ws_send))
        fallback_task = asyncio.create_task(fallback())

        async for raw in ws:
            if DEBUG: print("📩 WS recv raw:", raw)
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            kind = msg.get("action") or msg.get("type")
            if DEBUG: print("➡️ kind:", kind)

            if kind == "sessionStarted":
                print("🟢 sessionStarted 수신 → 정지 감지 시작")
                if (not cam_task) or cam_task.done():
                    cam_task = asyncio.create_task(stillness_detect_and_signal(ws_send))
                if not fallback_task.done():
                    fallback_task.cancel()
                continue

            if kind == "sessionEnded":
                print("🔴 sessionEnded 수신 → 다음 세션 대기")
                if not fallback_task.done():
                    fallback_task.cancel()
                fallback_task = asyncio.create_task(fallback())
                continue

# ===== main =====
async def main():
    while True:
        try:
            await ws_client()
        except Exception as e:
            print("WS reconnect in 2s due to:", e)
            await asyncio.sleep(2)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
