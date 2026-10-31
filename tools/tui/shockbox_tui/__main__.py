"""``python -m shockbox_tui`` — the thin shim the brief asks for.

The argument parser, path resolution and startup live in ``app.main``; this file only exists so
``python -m shockbox_tui`` works without a console-script install.
"""

import sys

from .app import main as _main

__all__ = ["main"]


def main() -> int:
    """The entry both ``python -m shockbox_tui`` and the ``shockbox`` console script reach."""
    return _main(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
