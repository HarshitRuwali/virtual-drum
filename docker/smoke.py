"""Container smoke test. Must exercise create_from_options(), not just import."""
import sys
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions

lm = vision.HandLandmarker.create_from_options(
    vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=sys.argv[1]),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=2,
    )
)
print("create_from_options OK")
