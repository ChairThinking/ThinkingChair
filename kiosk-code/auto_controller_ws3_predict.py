#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Autostart Controller (Merged)
- 자동실행 컨트롤러 흐름 + '추론 강화' 기능 통합본
- B안(프론트 주도 결제)와 완전 호환: 여기서는 결제/세션 종료 안 만짐
"""

import os, time, json, threading, subprocess, collections, re
from datetime import datetime, timezone
from collections import deque

import numpy as np
import cv2
from ultralytics import YOLO
import websocket  # pip install websocket-client

# ───────── 환경 변수/기본값 ─────────
WS_URL       = os.environ.get("WS_URL", "ws://localhost:3000")
OV_MODEL_DIR = os.environ.get("OV_MODEL_DIR", "/home/pi/Desktop/detect/finetune_my8_es/weights/best_openvino_model")
MODEL_IMG    = int(os.environ.get("MODEL_IMG", "832"))

# 🔧 민감도 조정: 실패 시 낮춰 탐지 스타트가 되도록
PRIMARY_CONF        = float(os.environ.get("PRIMARY_CONF", "0.3"))
IOU_THRESHOLD       = float(os.environ.get("IOU_THRESHOLD", "0.70"))
CONF_THRESHOLD      = float(os.environ.get("CONF_THRESHOLD", "0.3")) 
DETECTION_THRESHOLD = int(os.environ.get("DETECTION_THRESHOLD", "1"))  # was 1 (유지)
APPLY_LIGHT_ENHANCE = os.environ.get("APPLY_LIGHT_ENHANCE", "1") == "1"
AGNOSTIC_NMS        = os.environ.get("AGNOSTIC_NMS", "1") == "1"

LOOP_SLEEP_S  = float(os.environ.get("LOOP_SLEEP_S", "0.02"))
HB_PERIOD_S   = float(os.environ.get("HB_PERIOD_S", "1.0"))

CAM_W       = int(os.environ.get("CAM_W", "640"))
CAM_H       = int(os.environ.get("CAM_H", "480"))
CAM_FPS     = int(os.environ.get("CAM_FPS", "25"))
CAM_SHUTTER = int(os.environ.get("CAM_SHUTTER", "20000"))
CAM_GAIN    = float(os.environ.get("CAM_GAIN", "1.0"))
CAM_DENOISE = os.environ.get("CAM_DENOISE", "off")

SAVE_DIR    = os.environ.get("SAVE_DIR", "/home/pi/kiosk_captures")
SESSION_SID = os.environ.get("SESSION_SID", "default")  # WS 세션 라우팅용 기본 sid

def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")

# ── [추론 강화] '큰 박스가 작은 박스를 포함' 시 작은 박스를 제거 (동일 클래스 & 더 낮은 conf)
def drop_inner_boxes(boxes_xyxy, scores, classes, contain_thr=0.90):
    keep = []
    b = np.asarray(boxes_xyxy, dtype=np.float32)
    s = np.asarray(scores, dtype=np.float32)
    c = np.asarray(classes, dtype=np.int32)

    for i in range(len(b)):
        xi1, yi1, xi2, yi2 = b[i]
        ai = max(0.0, (xi2 - xi1)) * max(0.0, (yi2 - yi1))
        if ai <= 0:
            continue
        drop = False
        for j in range(len(b)):
            if i == j:
                continue
            if c[i] == c[j] and s[j] >= s[i]:
                xj1, yj1, xj2, yj2 = b[j]
                inter_w = max(0.0, min(xi2, xj2) - max(xi1, xj1))
                inter_h = max(0.0, min(yi2, yj2) - max(yi1, yi1))
                inter = inter_w * inter_h
                if inter / ai > contain_thr:
                    drop = True
                    break
        if not drop:
            keep.append(i)
    return keep


class Controller:
    def __init__(self):
        print("[BOOT] controller start", flush=True)

        # 상태
        self.phase = "waiting"            # waiting | scanning
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

        # 안정성/중복 방지
        self._last_frame_sig = None
        self._same_sig_frames = 0
        self._last_frame_time_ms = 0
        self._last_sent_sig = None

        # 최근 시각화/시그널
        self._last_ann = None
        self._last_sig = None

        # scanComplete 1회 발행 가드
        self._scan_complete_sent = False

        # 세션 라우팅 sid (WS hello로 서버가 rebind해줌)
        self.session_id = SESSION_SID

    # ── WS 유틸
    def ws_send_json(self, obj):
        try:
            # 항상 sessionId를 실어보내 라우팅 안전
            obj.setdefault("sessionId", self.session_id)
            s = json.dumps(obj, ensure_ascii=False)
            (self.ws or self.ws_app).send(s)
        except Exception as e:
            print("[WS] send err:", e, flush=True)

    # ── WS 콜백
    def _on_ws_open(self, ws):
        print("✅ WS connected", flush=True)
        self.ws = ws
        # 역할 등록 (서버가 hello 수신 후 sid를 열린 세션의 sid로 rebind)
        self.ws_send_json({"type": "hello", "role": "controller", "sessionId": self.session_id})

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
        k = kind.lower()

        # 🔧 sessionStarted: 세션 "코드"는 라우팅 sid가 아님 → sid 덮어쓰지 말 것
        if k == "sessionstarted" and "session" in m:
            sess_code = m["session"].get("session_code")
            print(f"[WS] sessionStarted (code={sess_code}) → ready for startVision", flush=True)
            # 상태 리셋
            self.request_vision_stop()
            self._scan_complete_sent = False
            self._last_sent_sig = None
            self._last_frame_sig = None
            self._same_sig_frames = 0
            return

        if k == "startvision":
            print("[WS] startVision", flush=True)
            self.request_vision_start()
            return

        if k == "stopvision":
            print("[WS] stopVision", flush=True)
            self.request_vision_stop()
            return

        # (선택) 서버가 goToScreen을 던지는 경우 정지 가드
        if k == "gotoscreen" and m.get("screen") in ("screen-items", "screen-start"):
            self.request_vision_stop()
            return

    # ── start/stop 요청
    def request_vision_start(self):
        if self._vision_requested and self.yolo_enabled:
            print("[YOLO] already starting/started", flush=True)
            return
        self._vision_requested = True
        print("[CMD] request vision start", flush=True)

        self.start_camera()
        self.start_yolo_async()
        self.yolo_enabled = True
        self.phase = "scanning"

        self._scan_complete_sent = False
        self._last_sent_sig = None
        self._last_frame_sig = None
        self._same_sig_frames = 0

    def request_vision_stop(self):
        if not self.yolo_enabled and not self._vision_requested:
            return
        print("[CMD] request vision stop", flush=True)
        self.yolo_enabled = False
        self._vision_requested = False
        self._vision_ready_sent = False
        self.phase = "waiting"
        # 모델은 warm 상태 유지 (재시작 빠르게)

    # ── WS 시작
    def start_ws(self):
        # 무한 재연결 루프: 노드가 나중에 떠도 자동 복구
        def _ws_forever():
            backoff = 0.5
            while True:
                try:
                    self.ws_app = websocket.WebSocketApp(
                        WS_URL,
                        on_open=self._on_ws_open,
                        on_message=self._on_ws_message,
                        on_close=self._on_ws_close,
                        on_error=self._on_ws_error,
                    )
                    self.ws_app.run_forever(ping_interval=20, ping_timeout=10)
                except Exception as e:
                    print("[WS] run_forever error:", e, flush=True)
                finally:
                    self.ws = None
                print("[WS] reconnect in", backoff, "sec", flush=True)
                time.sleep(backoff)
                backoff = min(backoff * 1.5, 5.0)
        threading.Thread(target=_ws_forever, daemon=True).start()

    # ── 카메라 (rpicam-vid → YUV420 → BGR)
    def start_camera(self):
        if self.cam_thread and self.cam_thread.is_alive():
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
                print("[ERR] start_yolo:", repr(e), flush=True)
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

    # ── 1 step inference (추론 강화 통합)
    def yolo_tick(self, bgr):
        if not (self.yolo_enabled and self.yolo_ready and self.model is not None):
            return None

        # 입력 전처리
        inp = cv2.resize(bgr, (self._imgsz, self._imgsz))
        if APPLY_LIGHT_ENHANCE:
            inp = cv2.GaussianBlur(inp, (0, 0), 1.0)
            inp = cv2.addWeighted(inp, 1.6, inp, -0.6, 0)

        # 추론 (동적 imgsz 보정 포함)
        try:
            results = self.model(
                inp,
                imgsz=MODEL_IMG,
                conf=PRIMARY_CONF,
                iou=IOU_THRESHOLD,
                agnostic_nms=AGNOSTIC_NMS,
                verbose=False
            )
        except RuntimeError as e:
            msg = str(e)
            m = re.search(r"shape=\[1,3,(\d+),\1\]", msg)
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

        # numpy로
        xyxy   = boxes.xyxy.cpu().numpy()
        scores = boxes.conf.cpu().numpy()
        clses  = boxes.cls.cpu().numpy().astype(int)

        # 후처리 1차 필터
        mask = scores >= CONF_THRESHOLD
        xyxy, scores, clses = xyxy[mask], scores[mask], clses[mask]
        if len(scores) == 0:
            self._same_sig_frames = 0; self._last_frame_sig = None
            return None

        # 중첩 박스 제거
        keep_idx = drop_inner_boxes(xyxy, scores, clses, contain_thr=0.90)
        xyxy, scores, clses = xyxy[keep_idx], scores[keep_idx], clses[keep_idx]
        if len(scores) == 0:
            self._same_sig_frames = 0; self._last_frame_sig = None
            return None

        # 집계
        counts  = collections.defaultdict(int)
        maxconf = collections.defaultdict(float)
        names = getattr(self.model, "names", {})
        for cid, conf in zip(clses, scores):
            if cid not in names:
                continue
            name = names[cid]
            counts[name] += 1
            if conf > maxconf[name]:
                maxconf[name] = float(conf)

        if not counts:
            self._same_sig_frames = 0; self._last_frame_sig = None
            return None

        # 간단 안정화
        sig = tuple(sorted((k, int(v)) for k, v in counts.items()))
        now_ms = int(time.time() * 1000)
        if now_ms - self._last_frame_time_ms > 1200:
            self._same_sig_frames = 0; self._last_frame_sig = None
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

        # 대표 class / best conf
        main = max(counts.items(), key=lambda kv: (kv[1], maxconf.get(kv[0], 0.0)))[0]
        best = float(maxconf.get(main, 0.0))
        self._last_sent_sig = sig

        # (선택) 시각화 저장
        try:
            ann = r.orig_img.copy()
            for (x1,y1,x2,y2), cid, conf in zip(xyxy, clses, scores):
                color = (255, 0, 0)
                cv2.rectangle(ann, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
                label = f"{names.get(int(cid), cid)} {conf:.2f}"
                cv2.putText(ann, label, (int(x1), int(y1)-8),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
            self._last_ann = ann
            self._last_sig = sig
        except Exception as e:
            print("[IMG] ann make failed:", e, flush=True)

        return {
            "type": "yoloDetection",
            "class": main,
            "conf": round(best, 3),
            "counts": {k: int(v) for k, v in counts.items()},
            "ts": now_iso(),
            "sessionId": self.session_id,  # 🔧 늘 포함
        }

    # ── 메인 루프
    def start_main_loop(self):
        def _run():
            print("[MAIN] loop start (waiting)", flush=True)
            last_detection_time = 0.0
            last_objects = {}
            while True:
                # 하트비트
                now = time.time()
                if now - self._hb_last >= HB_PERIOD_S:
                    self._hb_last = now
                    print(f"[HB] phase={self.phase} qlen={len(self.frame_q)} ready={self.yolo_ready}", flush=True)

                # 프레임 최신본 가져오기
                with self.frame_lock:
                    if not self.frame_q:
                        time.sleep(LOOP_SLEEP_S); continue
                    bgr, gray = self.frame_q[-1]

                # 준비 알림(1회)
                if (self.phase == "scanning") and self.yolo_ready and not self._vision_ready_sent:
                    self.ws_send_json({"type": "visionReady", "ts": now_iso()})
                    self._vision_ready_sent = True
                    print("🟢 visionReady sent", flush=True)

                # 추론/안정화
                if self.phase == "scanning":
                    ev = self.yolo_tick(bgr)
                    if ev:
                        self.ws_send_json(ev)
                        last_detection_time = time.time()
                        last_objects = ev["counts"]
                    else:
                        # 마지막 유효 결과가 없으면 종료 판정 리셋
                        if not last_objects:
                            last_detection_time = time.time()
                        # 비어있지 않은 결과가 5초간 변동 없으면 scanComplete 1회 발행
                        elif time.time() - last_detection_time > 5:
                            if not self._scan_complete_sent:
                                print("[AUTO] scanComplete (stable non-empty detection)")
                                # 최종 1장 저장
                                try:
                                    date_dir = datetime.now().strftime("%Y%m%d")
                                    path = os.path.join(SAVE_DIR, date_dir)
                                    os.makedirs(path, exist_ok=True)
                                    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
                                    if self._last_ann is not None:
                                        out_path = os.path.join(path, f"{ts}_final.jpg")
                                        ok = cv2.imwrite(out_path, self._last_ann)
                                        print(f"[IMG] final saved → {out_path}" if ok else f"[IMG] final save FAILED → {out_path}", flush=True)
                                except Exception as e:
                                    print("[IMG] final save failed:", e, flush=True)
                                self.ws_send_json({
                                    "type": "scanComplete",
                                    "counts": last_objects,
                                    "ts": now_iso(),
                                    "sessionId": self.session_id,
                                })
                                self._scan_complete_sent = True
                            # 대기 상태로 전환
                            self.request_vision_stop()
                            last_detection_time = time.time() + 99999

                time.sleep(LOOP_SLEEP_S)

        threading.Thread(target=_run, daemon=True).start()

    # ── 실행
    def run(self):
        self.start_ws()
        self.start_camera()     # 카메라 미리 켜도 OK (startVision 없으면 추론 안함)
        self.start_main_loop()
        try:
            while True:
                time.sleep(1.0)
        except KeyboardInterrupt:
            print("⏹ exit", flush=True)


if __name__ == "__main__":
    Controller().run()
