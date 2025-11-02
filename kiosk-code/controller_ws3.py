#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os, time, json, threading, subprocess, collections, re
from datetime import datetime, timezone
from collections import deque

import numpy as np
import cv2
from ultralytics import YOLO
import websocket  # pip install websocket-client

# ───────── 설정 ─────────
WS_URL       = os.environ.get("WS_URL", "ws://localhost:3000")
OV_MODEL_DIR = os.environ.get("OV_MODEL_DIR", "/home/pi/Desktop/detect/finetune_my6_es/weights/best_openvino_model")
MODEL_IMG    = int(os.environ.get("MODEL_IMG", "640"))

PRIMARY_CONF        = float(os.environ.get("PRIMARY_CONF", "0.12"))
IOU_THRESHOLD       = float(os.environ.get("IOU_THRESHOLD", "0.6"))
CONF_THRESHOLD      = float(os.environ.get("CONF_THRESHOLD", "0.15"))
DETECTION_THRESHOLD = int(os.environ.get("DETECTION_THRESHOLD", "1"))
APPLY_LIGHT_ENHANCE = os.environ.get("APPLY_LIGHT_ENHANCE", "1") == "1"

LOOP_SLEEP_S  = float(os.environ.get("LOOP_SLEEP_S", "0.02"))
HB_PERIOD_S   = float(os.environ.get("HB_PERIOD_S", "1.0"))

CAM_W      = int(os.environ.get("CAM_W", "640"))
CAM_H      = int(os.environ.get("CAM_H", "480"))
CAM_FPS    = int(os.environ.get("CAM_FPS", "25"))
CAM_SHUTTER= int(os.environ.get("CAM_SHUTTER", "20000"))
CAM_GAIN   = float(os.environ.get("CAM_GAIN", "1.0"))
CAM_DENOISE= os.environ.get("CAM_DENOISE", "off")

def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")

# ───────── 컨트롤러 ─────────
class Controller:
    def __init__(self):
        print("[BOOT] controller start", flush=True)

        # 상태
        self.phase = "waiting"        # waiting | scanning
        self.model = None
        self._imgsz = int(os.environ.get("IMG_SIZE", str(MODEL_IMG)))

        self._vision_requested = False
        self._vision_ready_sent = False
        self._yolo_starting = False
        self.yolo_ready = False
        self.yolo_enabled = False

        # WS & 프레임
        self.ws_app = None
        self.ws = None
        self.frame_q = deque(maxlen=3)
        self.frame_lock = threading.Lock()

        self._hb_last = time.time()
        self.cam_proc = None
        self.cam_thread = None
        self._yuv_stash = bytearray()

        # 안정성 보조
        self._last_frame_sig = None
        self._same_sig_frames = 0
        self._last_frame_time_ms = 0
        self._last_sent_sig = None

        self._last_ann = None
        self._last_sig = None

        self._scan_complete_sent = False

    # ── WS 유틸
    def ws_send_json(self, obj):
        try:
            s = json.dumps(obj, ensure_ascii=False)
            (self.ws or self.ws_app).send(s)
        except Exception as e:
            print("[WS] send err:", e, flush=True)

    # ── WS 콜백
    def _on_ws_open(self, ws):
        print("✅ WS connected", flush=True)
        self.ws = ws  # autostart/visionReady 선발송 없음
        self.ws_send_json({"type": "hello", "role": "controller", "sessionId": "default"})

    def _on_ws_close(self, ws, code, msg):
        print("[WS] closed:", code, msg, flush=True)
        self.ws = None

    def _on_ws_error(self, ws, err):
        print("[WS] error:", err, flush=True)

    def _on_ws_message(self, ws, raw):
        try:
            m = json.loads(raw)
        except Exception:
            return
        kind = (m.get("type") or m.get("action") or "").strip()

        # 1. 세션 시작 수신 → sessionId 갱신
        if kind == "sessionStarted" and "session" in m:
            sid = m["session"].get("session_code") or m["session"].get("id")
            if sid:
                self.session_id = sid
                print(f"[WS] sessionStarted received → sessionId = {sid}", flush=True)

                # # (선택) 서버에 재등록
                # self.ws_send_json({
                #     "type": "hello",
                #     "role": "controller",
                #     "sessionId": sid
                # })

                # ✅ 새 세션 시작 시 YOLO/상태 리셋 (대기 모드)
                self.request_vision_stop()  # YOLO 끄기, phase="waiting"
                self._scan_complete_sent = False
                self._last_sent_sig = None
                self._last_frame_sig = None
                self._same_sig_frames = 0
                print("[WS] session ready → waiting for startVision (by lidar)", flush=True)

            return

        # 2.
        if kind == "startVision":
            print("[WS] startVision", flush=True)
            self.request_vision_start()
            return

        # 3. 
        if kind == "stopVision":
            self.request_vision_stop()
            return

    # ── start/stop 요청
    def request_vision_start(self):
        if self._vision_requested:
            print("[YOLO] already starting/started", flush=True)
            return
        self._vision_requested = True
        print("[WS] startVision", flush=True)

        self.start_camera()
        self.start_yolo_async()
        self.yolo_enabled = True
        self.phase = "scanning"

        self._scan_complete_sent = False

    def request_vision_stop(self):
        print("[WS] stopVision", flush=True)
        self.yolo_enabled = False
        self._vision_requested = False
        self._vision_ready_sent = False
        self.phase = "waiting"
        # 모델은 유지(빠른 재시작). 완전 종료하려면 아래 두 줄 해제
        # self.model = None
        # self.yolo_ready = False

    # ── WS 시작
    def start_ws(self):
        self.ws_app = websocket.WebSocketApp(
            WS_URL,
            on_open=self._on_ws_open,
            on_message=self._on_ws_message,
            on_close=self._on_ws_close,
            on_error=self._on_ws_error,
        )
        threading.Thread(target=self.ws_app.run_forever,
                         kwargs={"ping_interval": 20, "ping_timeout": 10},
                         daemon=True).start()

    # ── 카메라 (rpicam-vid → YUV420 → BGR)
    def start_camera(self):
        if self.cam_thread and self.cam_thread.is_alive():  # 이미 실행 중
            return
        cmd = [
            "rpicam-vid",
            "-t", "0",
            "-n",
            "--width", str(CAM_W),
            "--height", str(CAM_H),
            "--framerate", str(CAM_FPS),
            "--codec", "yuv420",
            "--shutter", str(CAM_SHUTTER),
            "--gain", str(CAM_GAIN),
            "--denoise", str(CAM_DENOISE),
            "-o", "-"
        ]
        print("[CAM] exec:", " ".join(map(str, cmd)), flush=True)
        self.cam_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        print(f"[CAM] rpicam-vid PID={self.cam_proc.pid}", flush=True)
        self._yuv_stash = bytearray()

        def _reader():
            frame_size = CAM_W * CAM_H * 3 // 2
            while True:
                chunk = self.cam_proc.stdout.read(4096)
                if not chunk:
                    time.sleep(0.005); continue
                self._yuv_stash.extend(chunk)
                while len(self._yuv_stash) >= frame_size:
                    fb = self._yuv_stash[:frame_size]
                    del self._yuv_stash[:frame_size]
                    yuv = np.frombuffer(fb, dtype=np.uint8).reshape((CAM_H * 3 // 2, CAM_W))
                    bgr = cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR_I420)
                    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
                    with self.frame_lock:
                        self.frame_q.append((bgr, gray))

        self.cam_thread = threading.Thread(target=_reader, daemon=True)
        self.cam_thread.start()

    # ── YOLO 로딩
    def start_yolo_async(self):
        if self._yolo_starting or self.yolo_ready:
            print("[YOLO] already starting/started", flush=True); return
        self._yolo_starting = True
        print("[YOLO] async loader spawn", flush=True)

        def _load():
            try:
                self.start_yolo()
            except Exception as e:
                print("[ERR] start_yolo_async:", repr(e), flush=True)
                self.model = None; self.yolo_ready = False; self.yolo_enabled = False
            finally:
                self._yolo_starting = False
                print("[YOLO] async loader end", flush=True)

        threading.Thread(target=_load, daemon=True).start()

    def start_yolo(self):
        print("[YOLO] starting...", flush=True)
        try:
            if not os.path.exists(OV_MODEL_DIR):
                print(f"[ERR] OV model path not found: {OV_MODEL_DIR}", flush=True)
                self.model = None; self.yolo_ready = False; return

            print(f"[YOLO] loading OpenVINO model: {OV_MODEL_DIR}", flush=True)
            self.model = YOLO(OV_MODEL_DIR)

            dummy = np.zeros((self._imgsz, self._imgsz, 3), np.uint8)
            _ = self.model(dummy, imgsz=self._imgsz, verbose=False)  # warm-up

            self.yolo_ready = True
            print("[YOLO] ready", flush=True)
        except Exception as e:
            print("[ERR] start_yolo failed:", repr(e), flush=True)
            self.model = None; self.yolo_ready = False

    # ── 1 step inference
    def yolo_tick(self, bgr):
        if not (self.yolo_enabled and self.yolo_ready and self.model is not None):
            return None

        inp = cv2.resize(bgr, (self._imgsz, self._imgsz))
        if APPLY_LIGHT_ENHANCE:
            inp = cv2.GaussianBlur(inp, (0, 0), 1.0)
            inp = cv2.addWeighted(inp, 1.6, inp, -0.6, 0)

        try:
            results = self.model(inp, imgsz=self._imgsz, conf=PRIMARY_CONF, iou=IOU_THRESHOLD, verbose=False)
        except RuntimeError as e:
            msg = str(e); m = re.search(r"shape=\[1,3,(\d+),\1\]", msg)
            if m:
                self._imgsz = int(m.group(1))
                inp = cv2.resize(bgr, (self._imgsz, self._imgsz))
                results = self.model(inp, imgsz=self._imgsz, conf=PRIMARY_CONF, iou=IOU_THRESHOLD, verbose=False)
            else:
                raise

        r = results[0]
        boxes = getattr(r, "boxes", None)
        if boxes is None or not hasattr(boxes, "cls") or len(boxes.cls) == 0:
            self._same_sig_frames = 0; self._last_frame_sig = None
            return None

        counts = collections.defaultdict(int)
        maxconf = collections.defaultdict(float)
        names = getattr(self.model, "names", {})

        for i in range(len(boxes.cls)):
            try:
                conf = float(boxes.conf[i])
            except Exception:
                continue
            if conf < CONF_THRESHOLD: continue
            cid = int(boxes.cls[i])
            if cid not in names: continue
            name = names[cid]
            counts[name] += 1
            if conf > maxconf[name]: maxconf[name] = conf

        if not counts:
            self._same_sig_frames = 0; self._last_frame_sig = None
            return None

        # 간단 안정성
        sig = tuple(sorted((k, int(v)) for k, v in counts.items()))
        now_ms = int(time.time() * 1000)
        if now_ms - self._last_frame_time_ms > 1200:
            self._same_sig_frames = 0; self._last_frame_sig = None
        if sig == self._last_frame_sig: self._same_sig_frames += 1
        else: self._last_frame_sig = sig; self._same_sig_frames = 1
        self._last_frame_time_ms = now_ms

        if self._same_sig_frames < DETECTION_THRESHOLD: return None
        if self._last_sent_sig == sig: return None

        main = max(counts.items(), key=lambda kv: (kv[1], maxconf.get(kv[0], 0.0)))[0]
        best = float(maxconf.get(main, 0.0))

        self._last_sent_sig = sig

        # 6) 이미지 저장 (옵션)
        # ann 프레임 보관만 하고 저장은 하지 않음
        try:
            ann = r.plot()
            self._last_ann = ann
            self._last_sig = sig
        except Exception as e:
            print("[IMG] ann make failed:", e, flush=True)

        self._last_sent_sig = sig    
 

        return {
            "type": "yoloDetection",
            "class": main,
            "conf": round(best, 3),
            "counts": {k: int(v) for k, v in counts.items()},
            "ts": now_iso()
        }

    # ── 메인 루프
    def start_main_loop(self):
        def _run():
            print("[MAIN] loop start (waiting)", flush=True)
            while True:
                # 하트비트
                now = time.time()
                if now - self._hb_last >= HB_PERIOD_S:
                    self._hb_last = now
                    print(f"[HB] phase={self.phase} qlen={len(self.frame_q)} ready={self.yolo_ready}", flush=True)

                with self.frame_lock:
                    if not self.frame_q:
                        time.sleep(LOOP_SLEEP_S); continue
                    bgr, gray = self.frame_q[-1]

                # 준비 알림(1회)
                if (self.phase == "scanning") and self.yolo_ready and not self._vision_ready_sent:
                    self.ws_send_json({"type": "visionReady", "ts": now_iso()})
                    self._vision_ready_sent = True
                    print("🟢 visionReady sent", flush=True)

                # 추론
                if self.phase == "scanning":
                    ev = self.yolo_tick(bgr)
                    if ev:
                        self.ws_send_json(ev)
                        last_detection_time = time.time()
                        last_objects = ev["counts"]
                    else:
                        # 변화 감지 타이머 로직 (빈 결과는 안정화로 보지 않음)
                        if 'last_detection_time' not in locals():
                            last_detection_time = time.time()
                            last_objects = {}
                        # 마지막 결과가 비어있으면 타이머를 계속 리셋해서 종료가 일어나지 않게 함
                        if not last_objects:
                            last_detection_time = time.time()
                        # 마지막 결과(객체 구성)가 "존재"하고 5초 동안 변화 없을 때만 완료
                        elif time.time() - last_detection_time > 5:  # 5초 동안 변화 없음
                            if not self._scan_complete_sent:
                                print("[AUTO] scanComplete (stable non-empty detection)")
                                # ===== 최종 1장 저장 (scanComplete에 1장) =====
                                try:
                                    base_dir = os.environ.get("SAVE_DIR", "/home/pi/kiosk_captures")
                                    date_dir = datetime.now().strftime("%Y%m%d")            # 예: 20251028
                                    save_dir = os.path.join(base_dir, date_dir)             # /home/pi/kiosk_captures/20251028
                                    os.makedirs(save_dir, exist_ok=True)

                                    # 파일명: 타임스탬프 + final
                                    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]   # ms 포함
                                    if self._last_ann is not None:
                                        out_path = os.path.join(save_dir, f"{ts}_final.jpg")
                                        ok = cv2.imwrite(out_path, self._last_ann)
                                        print(f"[IMG] final saved → {out_path}" if ok else f"[IMG] final save FAILED → {out_path}", flush=True)
                                    else:
                                        print("[IMG] final save skipped (no last_ann)", flush=True)
                                except Exception as e:
                                    print("[IMG] final save failed:", e, flush=True)
                                # ===============================
                                self.ws_send_json({
                                    "type": "scanComplete",
                                    "counts": last_objects,
                                    "ts": now_iso()
                                })
                                self._scan_complete_sent = True
                            self.phase = "waiting"
                            self.request_vision_stop()
                            last_detection_time = time.time() + 99999




                time.sleep(LOOP_SLEEP_S)

        threading.Thread(target=_run, daemon=True).start()

    # ── 실행
    def run(self):
        self.start_ws()
        self.start_camera()     # 카메라는 미리 켜도 OK (startVision 없으면 추론 안함)
        self.start_main_loop()
        try:
            while True: time.sleep(1.0)
        except KeyboardInterrupt:
            print("⏹ exit", flush=True)

# ───────── 엔트리 ─────────
if __name__ == "__main__":
    Controller().run()