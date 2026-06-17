"""PyInstaller entrypoint for the ftdc-engine sidecar binary."""

import sys

from ftdc_analyzer.cli import main

if __name__ == "__main__":
    sys.exit(main())
