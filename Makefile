# virtual-drum -- gates and helpers.
#
# Container-first (PLAN 1, 9.1): Python runs in a python:3.14-slim container,
# nothing is installed on the host. TS runs on node (host) -- it is a pure
# ES-module port with no native deps.

PY_IMG     ?= virtual-drum:latest
PY_DIR     := py
WEB_DIR    := web
FIXTURES   := web/test/fixtures

.PHONY: image py-test fixtures parity typecheck test assets deps serve serve-stop

image:
	docker build -t $(PY_IMG) -f docker/Dockerfile docker/

# Python core tests (PLAN 7.1), inside the container.
py-test: image
	docker run --rm \
		-v $(PWD)/$(PY_DIR):/w/$(PY_DIR):ro \
		-v $(PWD)/config:/w/config:ro \
		$(PY_IMG) \
		bash -lc "pip install -q --no-cache-dir pytest && cd /w && python -m pytest -p no:cacheprovider $(PY_DIR)/tests -v"

# Regenerate the parity fixtures from the PYTHON implementation.
# This must be the REAL generator, not the pytest case of the same name: that
# one writes to a tmp_path and leaves $(FIXTURES) untouched, so the gate would
# keep passing against stale expectations after a zone or constant change.
fixtures: image
	docker run --rm \
		-v $(PWD)/$(PY_DIR):/w/$(PY_DIR) \
		-v $(PWD)/config:/w/config \
		-v $(PWD)/$(FIXTURES):/w/$(FIXTURES) \
		$(PY_IMG) \
		bash -lc "cd /w && PYTHONPATH=$(PY_DIR) python -m vdrum.cli gen-parity-fixtures --out $(FIXTURES)"

# THE parity gate (PLAN 7.2): TS detect vs Python-expected, bit-exact.
parity:
	cd $(WEB_DIR) && npm install --no-audit --no-fund && npx vitest run

typecheck:
	cd $(WEB_DIR) && npx tsc --noEmit

# Full gate: both sides, every time you touch the core.
test: py-test parity typecheck

# ---- running the app -------------------------------------------------------
#
# Canonical way to start the browser app. HTTPS, because getUserMedia refuses to
# run on a non-localhost http origin (see docker/mkcert.sh), and bound to
# 0.0.0.0 so the machine with the camera can reach it.
#
# The certificate is self-signed, so the browser shows a warning once per host:
# proceed through it. The camera works after that -- a cert error does not stop
# an origin from being a secure context.
#
# VD_HOSTS is every address this box answers on, so one cert covers LAN and
# tailscale alike. Add your own with `make serve VD_HOSTS=drums.local`.
VD_PORT  ?= 5199
VD_HOSTS ?= $(shell hostname -I 2>/dev/null | tr ' ' ',' | sed 's/,*$$//')

# Run as the invoking user so npm leaves no root-owned files in the tree.
COMPOSE = VD_UID=$(shell id -u) VD_GID=$(shell id -g) \
	  VD_PORT=$(VD_PORT) VD_HOSTS="$(VD_HOSTS)" docker compose

serve:
	$(COMPOSE) up web

serve-stop:
	docker compose down --remove-orphans

# Web dependencies, in the container, so a fresh clone needs only docker.
# --no-deps skips cert issuance: installing does not need a server.
deps:
	$(COMPOSE) run --rm --no-deps web bash -lc "npm install --no-audit --no-fund"

# Download the hand model (7.8 MB, size verified per PLAN 2) and copy the
# wasm runtime, so the app works offline (no CDN dependency).
assets: deps
	mkdir -p assets $(WEB_DIR)/public/assets $(WEB_DIR)/public/wasm
	test -f assets/hand_landmarker.task || \
		wget -qO assets/hand_landmarker.task \
		"https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
	test "$$(stat -c%s assets/hand_landmarker.task)" = "7819105" && echo "model OK (7819105 bytes)"
	cp assets/hand_landmarker.task $(WEB_DIR)/public/assets/
	cp config/default.json config/zones.json $(WEB_DIR)/public/config/
	cp $(WEB_DIR)/node_modules/@mediapipe/tasks-vision/wasm/*.wasm $(WEB_DIR)/public/wasm/
