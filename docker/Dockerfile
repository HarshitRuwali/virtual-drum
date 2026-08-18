# Headless MediaPipe hand-tracking image for the virtual-drum detection core.
# No camera, display, or sound device is ever mounted — this runs against
# recorded fixtures only (see PLAN.md §1, §9).
FROM python:3.14-slim

# mediapipe 1.0.1's native bindings dlopen a GL/EGL chain at RUNTIME, inside
# HandLandmarker.create_from_options(). `import mediapipe` succeeds without any of
# it, so an import-only smoke test will NOT catch this. The chain surfaces one
# library at a time -- found by iterating: libxcb -> libEGL -> libGLESv2.
#   libegl1        -> libEGL.so.1
#   libgles2       -> libGLESv2.so.2
#   libgl1         -> libGL.so.1
#   libglib2.0-0   -> libgthread / glib
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      libegl1 libgles2 libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# mediapipe depends on opencv-contrib-python (the GUI build), which needs libxcb.
# Swap it for the headless variant rather than installing X libraries.
RUN pip install --no-cache-dir mediapipe==1.0.1 numpy \
 && pip uninstall -y opencv-contrib-python \
 && pip install --no-cache-dir opencv-contrib-python-headless==5.0.0.93

WORKDIR /w
