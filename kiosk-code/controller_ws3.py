#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os, sys, time, json, threading, subprocess, collections, queue
from datetime import datetime, timezone
from collections import deque

import numpy as np
import cv2
from ultralytics import YOLO
import websocket  # pip install websocket-client
import re

# ─────────────────────────────────────────────
# 설정값
# ─────────────────────────────────────────────
WS_URL              = os.environ.get("WS_URL", "ws://localhost:3000")
OV_MODEL_DIR        = os.environ.get("OV_MODEL_DIR", "/home/pi/Desktop/detect/finetune_my53/weights/best_openvino_model")
MODEL_IMG           = int(os.environ.get("MODEL_IMG", "640"))

PRIMARY_CONF        = float(os.environ.get("PRIMARY_CONF", "0.12"))   # 모델 내부 conf
IOU_THRESHOLD       = float(os.environ.get("IOU_THRESHOLD", "0.6"))
CONF_THRESHOLD      = float(os.environ.get("CONF_THRESHOLD", "0.15")) # 후단 필터링 conf
DETECTION_THRESHOLD = int(os.environ.get("DETECTION_THRESHOLD", "1")) # 안정 프레임 임계 (no-still 모드라도 프레임 내 안정성)
APPLY_LIGHT_ENHANCE = os.environ.get("APPLY_LIGHT_ENHANCE", "1") == "1"

SAVE_IMAGES         = os.environ.get("SAVE_IMAGES", "1") == "1"
JPEG_QUALITY        = int(os.environ.get("JPEG_QUALITY", "90"))

LOOP_SLEEP_S        = float(os.environ.get("LOOP_SLEEP_S", "0.02"))   # 메인루프 쉼
HB_PERIOD_S         = float(os.environ.get("HB_PERIOD_S", "1.0"))     # 하트비트 주기

CAM_W               = int(os.environ.get("CAM_W", "640"))
CAM_H               = int(os.environ.get("CAM_H", "480"))
CAM_FPS             = int(os.environ.get("CAM_FPS", "25"))
CAM_SHUTTER         = int(os.environ.get("CAM_SHUTTER", "20000"))
CAM_GAIN            = float(os.environ.get("CAM_GAIN", "1.0"))
CAM_DENOISE         = os.environ.get("CAM_DENOISE", "off")

# ---- one-shot / stopVision 종료 옵션 ----
ONE_SHOT = os.environ.get("ONE_SHOT", "1") == "1"             # 기본 ON (요청하신대로)
EXIT_ON_STOPVISION = os.environ.get("EXIT_ON_STOPVISION", "1") == "1"  # 기본 ON


# ─────────────────────────────────────────────
# 유틸
# ─────────────────────────────────────────────
def now_iso(with_tz=True):
    if with_tz:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    return datetime.utcnow().replace(tzinfo=timezone.utc).isoformat(timespec="milliseconds")

def ensure_day_dir():
    day = datetime.now().strftime("%Y%m%d")
    base = f"/home/pi/kiosk_captures/{day}"
    os.makedirs(base, exist_ok=True)
    return base

def make_filename(label, cnt, conf):
    ts = datetime.now().strftime("%H%M%S_%f")[:-3]
    return f"{ts}_{label}_cnt{cnt}_conf{conf:.2f}.jpg"

# ─────────────────────────────────────────────
# 컨트롤러
# ─────────────────────────────────────────────
class Controller:
    def __init__(self):
        print("[BOOT] controller start", flush=True)

        # 상태
        self.phase = "waiting"       # waiting | scanning
        self.had_detection = False
        self.last_detect_ts = 0.0

        self.yolo_enabled = False
        self.yolo_ready   = False
        self.model        = None

        self.ws_app = None
        self.ws     = None

        # 프레임 큐
        self.frame_q    = deque(maxlen=3)
        self.frame_lock = threading.Lock()

        # 내부 안정화용(프레임 서명)
        self._last_frame_sig     = None
        self._same_sig_frames    = 0
        self._last_frame_time_ms = 0
        self._last_sent_sig      = None

        # 하트비트
        self._hb_last = time.time()

        # 카메라 프로세스
        self.cam_proc = None
        self.cam_thread = None

        # YOLO 스타트 쓰레드 중복 방지
        self._yolo_starting = False

        # 입력 크기 상태 변수
        self._imgsz = int(os.environ.get("IMG_SIZE", str(MODEL_IMG)))  # 기본 640, 필요시 런타임 조정

        def request_quit(self, reason=""):
            print(f"[QUIT] {reason}", flush=True)
            # 더 이상 추론/송신 안 하도록 플래그
            try: self.yolo_enabled = False
            except: pass
            try: self.still_enabled = False
            except: pass

            # 카메라 프로세스 종료
            try:
                if getattr(self, "cam_proc", None):
                    self.cam_proc.terminate()
            except: pass

            # YOLO 스레드/자원 정리 (있는 경우)
            try:
                self.yolo_ready = False
                self.model = None
            except: pass

            # 웹소켓 닫기
            try:
                if getattr(self, "ws", None) and hasattr(self.ws, "close"):
                    self.ws.close()
            except: pass

            # 메인 루프 탈출 트리거
            self._terminate = True


    # ── WS 보조
    def ws_send_json(self, obj: dict):
        try:
            data = json.dumps(obj, ensure_ascii=False)
            if self.ws:
                self.ws.send(data)
            elif self.ws_app:
                self.ws_app.send(data)
        except Exception as e:
            print("[WS] send err:", e, flush=True)

    # ── WS 콜백
    def _on_ws_open(self, ws):
        print("[WS] connected (controller)", flush=True)
        self.ws = ws

        # ★ 정지 감지 없이 '자가부팅 스캔'
        self.phase = "scanning"
        self.yolo_enabled = True          # 사용 on
        # yolo_ready는 절대 여기서 False로 내리지 않음

        # 모델 비동기 로드
        self.start_yolo_async()

        # Node가 컨트롤러 준비로 전환할 수 있게 ACK 선제 발송
        self.ws_send_json({"type": "visionReady", "ts": now_iso(False)})
        print("[WS] visionReady sent (autostart)", flush=True)

    def _on_ws_close(self, ws, code, msg):
        print("[WS] closed:", code, msg, flush=True)
        self.ws = None

    def _on_ws_error(self, ws, err):
        print("[WS] error:", err, flush=True)

    def _on_ws_message(self, ws, raw):
        # 필요 로그
        # print("[WS<- RAW]", raw, flush=True)
        try:
            data = json.loads(raw)
        except Exception:
            return
        kind = (data.get("type") or data.get("action") or "").strip()

        if kind == "startVision":
            # 자가부팅 모드: 재진입/리셋 금지, ACK만 재송신
            print("[WS] startVision ignored (controller autostart)", flush=True)
            self.ws_send_json({"type": "visionReady", "ts": now_iso(False)})
            return

        if kind == "stopVision":
            if self.phase != "scanning":
                print("[WS] stopVision ignored (not scanning)", flush=True)
                return
            print("[WS] stopVision", flush=True)
            self.stop_yolo()
            self.phase = "waiting"
            # 정지 감지 안씀
            self.yolo_enabled = False
            self.yolo_ready   = False     # ready False는 오직 여기에서만!
            # (정지기/버퍼 초기화가 필요하면 여기에)
            return

        # 기타 메시지는 필요 시 확장

    # ── WS 실행
    def start_ws(self):
        self.ws_app = websocket.WebSocketApp(
            WS_URL,
            on_open=self._on_ws_open,
            on_message=self._on_ws_message,
            on_close=self._on_ws_close,
            on_error=self._on_ws_error,
        )
        t = threading.Thread(target=self.ws_app.run_forever, kwargs={"ping_interval": 20, "ping_timeout": 10}, daemon=True)
        t.start()

    # ── 카메라: rpicam-vid 파이프(YUV420) → BGR
    def start_camera(self):
        if self.cam_thread and self.cam_thread.is_alive():
            return
        cmd = [
            "rpicam-vid",
            "-t", "0",
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

        # ★ 누적 버퍼
        self._yuv_stash = bytearray()

        def _reader():
            frame_size = CAM_W * CAM_H * 3 // 2  # YUV420(I420)
            while True:
                try:
                    # 파이프는 chunk 단위로 오므로, 누적해서 프레임 단위로 자른다
                    chunk = self.cam_proc.stdout.read(4096)
                    if not chunk:
                        time.sleep(0.005)
                        continue
                    self._yuv_stash.extend(chunk)

                    # 프레임 여러 장이 한꺼번에 쌓일 수 있으므로 while로 소진
                    while len(self._yuv_stash) >= frame_size:
                        frame_bytes = self._yuv_stash[:frame_size]
                        del self._yuv_stash[:frame_size]

                        yuv = np.frombuffer(frame_bytes, dtype=np.uint8).reshape((CAM_H * 3 // 2, CAM_W))
                        bgr = cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR_I420)
                        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
                        with self.frame_lock:
                            self.frame_q.append((bgr, gray))

                except Exception as e:
                    # 스트림 hiccup 시 잠깐 대기 후 재시도
                    time.sleep(0.01)

        self.cam_thread = threading.Thread(target=_reader, daemon=True)
        self.cam_thread.start()


    # ── YOLO 로딩(비동기)
    def start_yolo_async(self):
        if self._yolo_starting:
            print("[YOLO] already starting/started", flush=True)
            return
        self._yolo_starting = True

        def _load():
            try:
                self.start_yolo()
            finally:
                self._yolo_starting = False
        threading.Thread(target=_load, daemon=True).start()

    def start_yolo(self):
        # 이미 준비된 상태면 재로딩 불필요
        if (self.model is not None) and self.yolo_ready:
            print("[YOLO] already ready", flush=True)
            self.yolo_enabled = True
            return

        print("[YOLO] starting...", flush=True)
        self.model = YOLO(OV_MODEL_DIR)  # OpenVINO format path
        dummy = np.zeros((self._imgsz, self._imgsz, 3), np.uint8)
        _ = self.model(dummy, imgsz=self._imgsz, verbose=False)

        # 로드 완료 → 준비/사용 ON
        self.yolo_ready   = True
        self.yolo_enabled = True
        self.had_detection = False
        self.last_detect_ts = time.time()
        print(f"Loading {OV_MODEL_DIR} for OpenVINO inference...", flush=True)
        print("Using OpenVINO LATENCY mode for batch=1 inference...", flush=True)
        print(f"[YOLO] ready: {OV_MODEL_DIR}", flush=True)

    def stop_yolo(self):
        # OpenVINO 모델 객체 해제까지는 라이브러리 동작에 따름
        self.yolo_enabled = False
        # self.model 은 유지(재사용) 하되 ready는 stopVision에서 False로 내림

    # ── YOLO 한 틱
    def yolo_tick(self, bgr):
        # 0) 준비/정지 가드
        print(f"[DBG] tick enter en={self.yolo_enabled} ready={self.yolo_ready} model={'ok' if self.model is not None else 'None'}", flush=True)
        if self.model is None or not self.yolo_ready:
            print("[DBG] early return: not ready/model None", flush=True)
            return None
        if not self.yolo_enabled:
            return None

        # 1) 전처리
        inp = cv2.resize(bgr, (self._imgsz, self._imgsz))
        if APPLY_LIGHT_ENHANCE:
            inp = cv2.GaussianBlur(inp, (0, 0), 1.0)
            inp = cv2.addWeighted(inp, 1.6, inp, -0.6, 0)

        # 2) 추론 (모델 입력 크기에 자동 맞춤)
        results = None
        try:
            results = self.model(
                inp, imgsz=self._imgsz, conf=PRIMARY_CONF, iou=IOU_THRESHOLD, verbose=False
            )
        except RuntimeError as e:
            msg = str(e)
            # 예: shape=[1,3,320,320] ... tensor (shape=(1.3.640.640))
            m = re.search(r"shape=\[1,3,(\d+),\1\]", msg)
            if m:
                new_sz = int(m.group(1))
                if new_sz != self._imgsz:
                    print(f"[YOLO] adjust imgsz {self._imgsz} → {new_sz} (from model hint)", flush=True)
                    self._imgsz = new_sz
                    inp = cv2.resize(bgr, (self._imgsz, self._imgsz))
                    results = self.model(
                        inp, imgsz=self._imgsz, conf=PRIMARY_CONF, iou=IOU_THRESHOLD, verbose=False
                    )
            if results is None:
                raise

        # r / boxes 정의
        r = results[0]
        boxes = getattr(r, "boxes", None)

        # 3) 카운트/최대 conf 집계
        current_counts = collections.defaultdict(int)
        current_maxconf = collections.defaultdict(float)

        if boxes is not None and hasattr(boxes, "cls") and len(boxes.cls) > 0:
            for i in range(len(boxes.cls)):
                try:
                    conf = float(boxes.conf[i])
                except Exception:
                    continue
                if conf < CONF_THRESHOLD:
                    continue
                cid = int(boxes.cls[i])
                names = getattr(self.model, "names", None)
                if not names or cid not in names:
                    continue
                name = names[cid]
                current_counts[name] += 1
                if conf > current_maxconf[name]:
                    current_maxconf[name] = conf

        if not current_counts:
            # 프레임 안정성 상태 리셋
            self._same_sig_frames = 0
            self._last_frame_sig = None
            return None

        # 4) 프레임 시그니처 & 안정성(간단)
        if not hasattr(self, "_last_frame_time_ms"): self._last_frame_time_ms = 0
        if not hasattr(self, "_same_sig_frames"):    self._same_sig_frames = 0
        if not hasattr(self, "_last_frame_sig"):     self._last_frame_sig = None
        if not hasattr(self, "_last_sent_sig"):      self._last_sent_sig = None

        sig = tuple(sorted((k, int(v)) for k, v in current_counts.items()))
        now_ms = int(time.time() * 1000)

        # 프레임 간 간격이 너무 길면 연속성 초기화
        if now_ms - self._last_frame_time_ms > 1200:
            self._same_sig_frames = 0
            self._last_frame_sig = None

        if sig == self._last_frame_sig:
            self._same_sig_frames += 1
        else:
            self._last_frame_sig = sig
            self._same_sig_frames = 1
        self._last_frame_time_ms = now_ms

        if self._same_sig_frames < DETECTION_THRESHOLD:
            return None
        if self._last_sent_sig == sig:
            return None

        # 5) 대표 라벨 선택
        main_label = max(
            current_counts.items(),
            key=lambda kv: (kv[1], current_maxconf.get(kv[0], 0.0))
        )[0]
        best_conf = float(current_maxconf.get(main_label, 0.0))

        # 6) 캡처 저장(옵션)
        annotated_path = None
        if SAVE_IMAGES:
            try:
                ann = r.plot()
                base_h, base_w = bgr.shape[:2]
                ann_up = cv2.resize(ann, (base_w, base_h))
                save_dir = ensure_day_dir()
                fname = make_filename(main_label, current_counts[main_label], best_conf)
                annotated_path = os.path.join(save_dir, fname)
                cv2.imwrite(annotated_path, ann_up, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
            except Exception as e:
                print("[IMG] save failed:", e, flush=True)

        ev = {
            "type": "yoloDetection",
            "class": main_label,
            "conf": round(best_conf, 3),
            "counts": {k: int(v) for k, v in current_counts.items()},
            "imgPath": annotated_path,
            "ts": now_iso()
        }
        self._last_sent_sig = sig
        self.last_detect_ts = time.time()
        self.had_detection = True
        return ev


    # ── 메인 루프 (no-still)
    def start_main_loop(self):
        def _run():
            print("[MAIN] loop start (waiting)", flush=True)
            while True:
                # 하트비트
                now = time.time()
                if now - self._hb_last >= HB_PERIOD_S:
                    self._hb_last = now
                    print(f"[HB] phase={self.phase} qlen={len(self.frame_q)} ready={bool(self.yolo_ready)} hadDet={self.had_detection}", flush=True)

                with self.frame_lock:
                    if not self.frame_q:
                        time.sleep(LOOP_SLEEP_S)
                        continue
                    bgr, gray = self.frame_q[-1]

                if self.phase != "scanning":
                    time.sleep(LOOP_SLEEP_S)
                    continue

                # 스캔 중이면 YOLO 처리
                ev = self.yolo_tick(bgr)
                if ev:
                    self.ws_send_json(ev)
                    # 필요 시 추가 로직…
                time.sleep(LOOP_SLEEP_S)

        t = threading.Thread(target=_run, daemon=True)
        t.start()

    # ── 실행
    def run(self):
        self.start_ws()
        self.start_camera()
        self.start_main_loop()
        # 메인 스레드 유지
        try:
            while True:
                time.sleep(1.0)
        except KeyboardInterrupt:
            print("⏹ exit", flush=True)

# ─────────────────────────────────────────────
# 엔트리
# ─────────────────────────────────────────────
if __name__ == "__main__":
    Controller().run()
