import sys
from pathlib import Path

# Make `import vdrum` work without an editable install (CI/container runs).
sys.path.insert(0, str(Path(__file__).resolve().parent))
